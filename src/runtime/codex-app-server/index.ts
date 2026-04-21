// src/runtime/codex-app-server/index.ts
//
// CodexAppServerRuntime — spawns `codex app-server`, speaks JSON-RPC over
// stdio, emits NotificationEvent and PermissionRequest through the
// AgentRuntime interface. Mirrors the ClaudeSdkRuntime shape.

import { spawn, execFile as nodeExecFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AgentRuntime, AgentRuntimeOptions, PermissionRequest,
} from '../types.js';
import type { NotificationEvent, UsageStats } from '../events.js';
import { StdioJsonlTransport } from './transport.js';
import { CodexAppServerClient } from './client.js';
import { CodexEventAdapter } from './event-adapter.js';
import { CodexApprovalBridge } from './approval-bridge.js';

const execFileAsync = promisify(nodeExecFile);
const MIN_CODEX_VERSION = '0.121.0';

type ExecFileFn = typeof execFileAsync;

// Module-level cache — isAvailable() result stable for process lifetime
let _availabilityCache: Promise<boolean> | null = null;

/** Test-only: reset the module-level availability cache. */
export function __testing_resetBinaryDetectCache(): void {
  _availabilityCache = null;
}

export interface CodexAppServerRuntimeDeps {
  execFile?: ExecFileFn;
  spawnSubprocess?: () => ChildProcess;
}

// Codex notification methods the adapter knows how to handle. The wrapper
// subscribes to each and fans the result into the session-level listeners.
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
  private readonly usageCbs = new Set<(u: UsageStats) => void>();

  private started = false;
  private closed = false;
  private transport: StdioJsonlTransport | null = null;
  private client: CodexAppServerClient | null = null;
  private threadId: string | null = null;

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

  async start(opts: AgentRuntimeOptions): Promise<void> {
    if (this.started) throw new Error('runtime already started');
    this.started = true;
    if (opts.signal.aborted) { this.closed = true; return; }
    opts.signal.addEventListener('abort', () => { void this.stop(); }, { once: true });

    const child = (this.deps.spawnSubprocess ?? spawnCodexAppServer)();
    const transport = new StdioJsonlTransport(child);
    this.transport = transport;
    const eventAdapter = new CodexEventAdapter();
    const approvalBridge = new CodexApprovalBridge({
      sessionId: opts.sessionId,
      emit: (req) => { for (const cb of this.permCbs) cb(req); },
    });

    const client = new CodexAppServerClient(transport);
    this.client = client;

    // Wire notification forwarding — adapter fans each method into NotificationEvents.
    for (const method of FORWARDED_METHODS) {
      client.onNotification(method, (params) => {
        const frame = eventAdapter.handle(method, params);
        for (const e of frame.events) for (const cb of this.eventCbs) cb(e);
        if (frame.usage) for (const cb of this.usageCbs) cb(frame.usage);
      });
    }

    // Wire server-initiated approval requests.
    client.onCommandExecutionApproval(async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const itemId = (p.itemId as string) ?? (p.callId as string) ?? 'unknown';
      const command = Array.isArray(p.command)
        ? (p.command as string[])
        : typeof p.command === 'string'
          ? [p.command as string]
          : [];
      const cwd = (p.cwd as string) ?? '';
      const decision = await approvalBridge.handleCommandExecutionApproval(itemId, command, cwd);
      return { decision: codexDecisionToRpc(decision) };
    });
    client.onFileChangeApproval(async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const itemId = (p.itemId as string) ?? (p.callId as string) ?? 'unknown';
      const path = (p.path as string) ?? '';
      const cached = eventAdapter.getItem(itemId);
      const changes = Array.isArray(cached?.changes)
        ? (cached!.changes as Array<{ kind: 'add' | 'delete' | 'update' }>)
        : [];
      const decision = await approvalBridge.handleFileChangeApproval(itemId, path, changes);
      return { decision: codexDecisionToRpc(decision) };
    });

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

      if (opts.sessionId) {
        const resumeResult = await client.request<
          { threadId: string; cwd?: string; model?: string; persistExtendedHistory: boolean },
          { thread: { id: string } }
        >('thread/resume', {
          threadId: opts.sessionId,
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const cb of this.eventCbs) cb({ kind: 'error', message });
      throw err;
    }
  }

  async sendInput(text: string): Promise<void> {
    if (this.closed || !this.client || !this.threadId) throw new Error('runtime closed');
    await this.turnStart(text);
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.client?.close(); } catch { /* ignore */ }
    try { await this.transport?.close(); } catch { /* ignore */ }
  }

  onEvent(cb: (e: NotificationEvent) => void) { this.eventCbs.add(cb); return () => this.eventCbs.delete(cb); }
  onPermissionRequest(cb: (r: PermissionRequest) => void) { this.permCbs.add(cb); return () => this.permCbs.delete(cb); }
  onUsage(cb: (u: UsageStats) => void) { this.usageCbs.add(cb); return () => this.usageCbs.delete(cb); }

  // ---- private ------------------------------------------------------------

  private async turnStart(text: string, effort?: string, model?: string): Promise<void> {
    if (!this.client || !this.threadId) throw new Error('runtime not initialized');
    await this.client.request<
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
  }
}

function codexDecisionToRpc(d: 'approved' | 'approved_for_session' | 'denied' | 'abort'): string {
  // Codex app-server expects exec/file approval responses as 'accept' | 'acceptForSession' | 'decline'.
  switch (d) {
    case 'approved': return 'accept';
    case 'approved_for_session': return 'acceptForSession';
    case 'denied': return 'decline';
    case 'abort': return 'decline';
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
