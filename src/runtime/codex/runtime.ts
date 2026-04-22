// src/runtime/codex/runtime.ts
//
// CodexAppServerRuntime — spawns `codex app-server`, speaks JSON-RPC over
// stdio, emits NotificationEvent + PermissionRequest through AgentRuntime.
// Methods not exposed by app-server throw UnsupportedByRuntimeError; see
// docs/superpowers/specs/2026-04-22-t14b-full-cutover-design.md §3.5.

import { spawn, execFile as nodeExecFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AgentRuntime, AgentRuntimeOptions, AgentRuntimeStartResult,
  PermissionRequest, AskUserQuestionRequest, ElicitationRequest,
  SendInputOptions, PermissionMode, McpServerConfig, McpSetServersResult,
  McpServerStatus, ContextUsage, AccountInfo, SlashCommandInfo, ModelInfo,
  AgentInfo, RewindResult,
} from '../types.js';
import type { NotificationEvent, UsageStats } from '../events.js';
import { StdioJsonlTransport } from './transport.js';
import { CodexAppServerClient } from './client.js';
import { CodexEventAdapter } from './event-adapter.js';
import {
  makeExecApprovalHandler, makeFileChangeApprovalHandler, makePermissionsApprovalHandler,
  type CodexApprovalResult,
} from './approval-handler.js';
import { UnsupportedByRuntimeError } from '../abstractions.js';

const execFileAsync = promisify(nodeExecFile);
const MIN_CODEX_VERSION = '0.121.0';

type ExecFileFn = typeof execFileAsync;

// Module-level cache — isAvailable() stable for process lifetime
let _availabilityCache: Promise<boolean> | null = null;

/** Test-only: reset the module-level availability cache. */
export function __testing_resetBinaryDetectCache(): void {
  _availabilityCache = null;
}

export interface CodexAppServerRuntimeDeps {
  execFile?: ExecFileFn;
  spawnSubprocess?: () => ChildProcess;
}

// Codex notifications fanned into NotificationEvents via the adapter.
const FORWARDED_METHODS = [
  'thread/started',
  'thread/tokenUsage/updated',
  'thread/status/changed',
  'thread/closed',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'item/mcpToolCall/progress',
  'item/plan/delta',
  'turn/diff/updated',
  'turn/plan/updated',
  'error',
  'serverRequest/resolved',
] as const;

export class CodexAppServerRuntime implements AgentRuntime {
  readonly provider = 'codex' as const;

  private readonly eventCbs = new Set<(e: NotificationEvent) => void>();
  private readonly permCbs = new Set<(r: PermissionRequest) => void>();
  private readonly askCbs = new Set<(r: AskUserQuestionRequest) => void>();
  private readonly elicitCbs = new Set<(r: ElicitationRequest) => void>();
  private readonly usageCbs = new Set<(u: UsageStats) => void>();

  private started = false;
  private closed = false;
  private transport: StdioJsonlTransport | null = null;
  private client: CodexAppServerClient | null = null;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;

  constructor(private deps: CodexAppServerRuntimeDeps = {}) {}

  static async isAvailable(execFile: ExecFileFn = execFileAsync): Promise<boolean> {
    if (_availabilityCache) return _availabilityCache;
    _availabilityCache = (async () => {
      try {
        const { stdout } = await execFile('codex', ['--version']);
        const match = stdout.match(/codex-cli\s+(\d+\.\d+\.\d+)/);
        if (!match) return false;
        return compareVersions(match[1], MIN_CODEX_VERSION) >= 0;
      } catch { return false; }
    })();
    return _availabilityCache;
  }

  async start(opts: AgentRuntimeOptions): Promise<AgentRuntimeStartResult> {
    if (this.started) throw new Error('runtime already started');
    this.started = true;
    if (opts.signal.aborted) { this.closed = true; throw new Error('aborted'); }
    opts.signal.addEventListener('abort', () => { void this.stop(); }, { once: true });

    const child = (this.deps.spawnSubprocess ?? spawnCodexAppServer)();
    const transport = new StdioJsonlTransport(child);
    this.transport = transport;
    const eventAdapter = new CodexEventAdapter();

    const client = new CodexAppServerClient(transport);
    this.client = client;

    // Event/usage fanout via the adapter.
    for (const method of FORWARDED_METHODS) {
      client.onNotification(method, (params) => {
        if (method === 'turn/started') {
          const p = (params ?? {}) as Record<string, unknown>;
          const turn = (p.turn ?? {}) as Record<string, unknown>;
          const id = typeof turn.id === 'string' ? turn.id : null;
          if (id) this.activeTurnId = id;
        } else if (method === 'turn/completed') {
          this.activeTurnId = null;
        }
        const frame = eventAdapter.handle(method, params);
        for (const e of frame.events) for (const cb of this.eventCbs) cb(e);
        if (frame.usage) for (const cb of this.usageCbs) cb(frame.usage);
      });
    }

    // Approval handlers — each produces a categorized PermissionRequest.
    const approvalCtx = {
      sdkSessionId: () => this.threadId,
      emitRequest: (r: PermissionRequest) => { for (const cb of this.permCbs) cb(r); },
    };
    const execApproval = makeExecApprovalHandler(approvalCtx);
    const fileApproval = makeFileChangeApprovalHandler(approvalCtx);
    const permApproval = makePermissionsApprovalHandler(approvalCtx);

    client.onCommandExecutionApproval(async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const itemId = (p.itemId as string) ?? (p.callId as string) ?? 'unknown';
      const cmd = Array.isArray(p.command)
        ? (p.command as string[]).join(' ')
        : typeof p.command === 'string' ? (p.command as string) : '';
      const result = await execApproval({ command: cmd, cwd: p.cwd as string | undefined, call_id: itemId });
      return { decision: codexResultToRpc(result) };
    });
    client.onFileChangeApproval(async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const itemId = (p.itemId as string) ?? (p.callId as string) ?? 'unknown';
      const path = (p.path as string) ?? '';
      const diff = (p.diff as string | undefined) ?? '';
      const result = await fileApproval({ path, diff, call_id: itemId });
      return { decision: codexResultToRpc(result) };
    });
    client.onPermissionsApproval(async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const itemId = (p.itemId as string) ?? (p.callId as string) ?? 'unknown';
      const result = await permApproval({
        description: (p.description as string | undefined),
        call_id: itemId,
        ...p,
      });
      // Codex permissions approval expects { permissions, scope } — for now return
      // an empty permission set and mark the scope from the user decision.
      if (result.outcome === 'denied') return { permissions: {}, scope: 'turn' };
      const scope = result.outcome === 'approved_for_session' ? 'session' : 'turn';
      return { permissions: {}, scope };
    });
    // Elicitation passthrough (T2 will wire the real flow).
    client.onMcpElicitation(async () => ({ action: 'decline', content: null }));

    transport.onExit(({ code }) => {
      if (code !== 0 && !this.closed) {
        for (const cb of this.eventCbs) cb({
          kind: 'error',
          message: `Codex app-server exited unexpectedly (code ${code})`,
        });
      }
      this.closed = true;
    });

    try {
      await client.initialize({
        clientInfo: { name: 'tlive', title: null, version: '1.0.0' },
        capabilities: { experimentalApi: false },
      });

      if (opts.resumeSdkSessionId) {
        const resumeResult = await client.request<
          { threadId: string; cwd?: string; model?: string; persistExtendedHistory: boolean },
          { thread: { id: string } }
        >('thread/resume', {
          threadId: opts.resumeSdkSessionId,
          cwd: opts.workdir,
          model: opts.model,
          persistExtendedHistory: false,
        });
        this.threadId = resumeResult.thread.id;
      } else {
        const startResult = await client.request<
          { cwd?: string; model?: string; experimentalRawEvents: boolean; persistExtendedHistory: boolean },
          { thread: { id: string } }
        >('thread/start', {
          cwd: opts.workdir,
          model: opts.model,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        });
        this.threadId = startResult.thread.id;
      }

      if (opts.initialPrompt) {
        await this.turnStart(opts.initialPrompt, opts.effort, opts.model);
      }

      return { sdkSessionId: this.threadId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const alreadyClosing = this.closed;
      this.closed = true;
      for (const cb of this.eventCbs) {
        try { cb({ kind: 'error', message }); } catch { /* ignore */ }
      }
      if (!alreadyClosing) {
        if (this.client) {
          try { await this.client.close(); } catch { /* ignore */ }
        } else {
          try { await this.transport?.close(); } catch { /* ignore */ }
        }
      }
      throw err;
    }
  }

  async sendInput(text: string, opts?: SendInputOptions): Promise<void> {
    if (this.closed || !this.client || !this.threadId) throw new Error('runtime closed');
    await this.turnStart(text, opts?.effort, opts?.model);
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.client && this.threadId && this.activeTurnId) {
      try {
        await this.client.request('turn/interrupt', {
          threadId: this.threadId,
          turnId: this.activeTurnId,
        });
      } catch { /* best effort */ }
    }
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
    } else {
      try { await this.transport?.close(); } catch { /* ignore */ }
    }
  }

  // ---- Control face ------------------------------------------------------

  async interrupt(): Promise<void> {
    if (!this.client || !this.threadId || !this.activeTurnId) return;
    try {
      await this.client.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: this.activeTurnId,
      });
    } catch { /* ignore */ }
  }

  async setModel(_model?: string): Promise<void> {
    throw new UnsupportedByRuntimeError('codex', 'setModel');
  }

  async setPermissionMode(_mode: PermissionMode): Promise<void> {
    // Codex permission mode is set via thread/start on session boot; changing
    // mid-session is not supported by the app-server protocol today.
    throw new UnsupportedByRuntimeError('codex', 'setPermissionMode');
  }

  async applyPermissionRules(_rules: { allow?: string[]; deny?: string[] }): Promise<void> {
    throw new UnsupportedByRuntimeError('codex', 'applyPermissionRules');
  }

  async stopTask(_taskId: string): Promise<void> {
    throw new UnsupportedByRuntimeError('codex', 'stopTask');
  }

  async supportedCommands(): Promise<SlashCommandInfo[]> {
    return [];
  }

  async supportedModels(): Promise<ModelInfo[]> {
    // Static list — codex app-server doesn't expose this yet. Kept minimal;
    // expanded by T10 alongside Codex prompt bundles.
    return [
      { id: 'gpt-5-codex', displayName: 'GPT-5 Codex' },
      { id: 'o4-mini', displayName: 'o4-mini' },
    ];
  }

  async supportedAgents(): Promise<AgentInfo[]> {
    return [];
  }

  async mcpServerStatus(): Promise<McpServerStatus[]> {
    return [];
  }

  async getContextUsage(): Promise<ContextUsage> {
    return {
      totalTokens: 0,
      systemPromptTokens: 0,
      messagesTokens: 0,
      toolsTokens: 0,
      mcpToolsTokens: 0,
      memoryFilesTokens: 0,
      maxTokens: 200000,
    };
  }

  async accountInfo(): Promise<AccountInfo> {
    return {};
  }

  async forkSession(_title?: string): Promise<{ sdkSessionId: string }> {
    throw new UnsupportedByRuntimeError('codex', 'forkSession');
  }

  async renameSession(_title: string): Promise<void> {
    throw new UnsupportedByRuntimeError('codex', 'renameSession');
  }

  async rewindFiles(_userMessageId: string, _opts?: { dryRun?: boolean }): Promise<RewindResult> {
    throw new UnsupportedByRuntimeError('codex', 'rewindFiles');
  }

  async reloadPlugins(): Promise<void> {
    throw new UnsupportedByRuntimeError('codex', 'reloadPlugins');
  }

  async setMcpServers(_servers: Record<string, McpServerConfig>): Promise<McpSetServersResult> {
    throw new UnsupportedByRuntimeError('codex', 'setMcpServers');
  }

  async reconnectMcpServer(_name: string): Promise<void> {
    throw new UnsupportedByRuntimeError('codex', 'reconnectMcpServer');
  }

  async toggleMcpServer(_name: string, _enabled: boolean): Promise<void> {
    throw new UnsupportedByRuntimeError('codex', 'toggleMcpServer');
  }

  // ---- Subscriptions -----------------------------------------------------

  onEvent(cb: (e: NotificationEvent) => void) { this.eventCbs.add(cb); return () => { this.eventCbs.delete(cb); }; }
  onPermissionRequest(cb: (r: PermissionRequest) => void) { this.permCbs.add(cb); return () => { this.permCbs.delete(cb); }; }
  onAskUserQuestion(cb: (r: AskUserQuestionRequest) => void) { this.askCbs.add(cb); return () => { this.askCbs.delete(cb); }; }
  onElicitation(cb: (r: ElicitationRequest) => void) { this.elicitCbs.add(cb); return () => { this.elicitCbs.delete(cb); }; }
  onUsage(cb: (u: UsageStats) => void) { this.usageCbs.add(cb); return () => { this.usageCbs.delete(cb); }; }

  // ---- private -----------------------------------------------------------

  private async turnStart(text: string, effort?: string, model?: string): Promise<void> {
    if (!this.client || !this.threadId) throw new Error('runtime not initialized');
    const result = await this.client.request<
      {
        threadId: string;
        input: Array<{ type: 'text'; text: string; text_elements: Array<unknown> }>;
        effort?: string;
        model?: string;
      },
      { turn: { id: string } }
    >('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      effort,
      model,
    });
    if (result?.turn?.id) this.activeTurnId = result.turn.id;
  }
}

function codexResultToRpc(r: CodexApprovalResult): string {
  switch (r.outcome) {
    case 'approved_for_request': return 'accept';
    case 'approved_for_session': return 'acceptForSession';
    case 'denied': return 'decline';
  }
}

/** Compare two dotted version strings. Returns -1 | 0 | 1. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** Spawn the codex app-server subprocess. */
function spawnCodexAppServer(): ChildProcess {
  return spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}
