import { spawn, execFile as nodeExecFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { LLMProvider, StreamChatParams, StreamChatResult, ProviderCapabilities, QueryControls } from '../base.js';
import { flavorCapabilities } from '../../flavors.js';
import { StdioJsonlTransport } from './transport.js';
import { CodexAppServerClient } from './client.js';
import { CodexEventAdapter } from './event-adapter.js';
import { CodexApprovalBridge } from './approval-bridge.js';
import type { CanonicalEvent } from '../../messages/schema.js';

const execFileAsync = promisify(nodeExecFile);
const MIN_CODEX_VERSION = '0.121.0';

type ExecFileFn = typeof execFileAsync;

// Module-level cache — isAvailable() result stable for process lifetime
let _availabilityCache: Promise<boolean> | null = null;

/** Test-only: reset the module-level availability cache. */
export function __testing_resetBinaryDetectCache(): void {
  _availabilityCache = null;
}

interface ProviderDeps {
  execFile?: ExecFileFn;
  spawnSubprocess?: () => ChildProcess;
}

export class CodexAppServerProvider implements LLMProvider {
  private execFile: ExecFileFn;
  private spawnSubprocess: () => ChildProcess;

  constructor(deps: ProviderDeps = {}) {
    this.execFile = deps.execFile ?? (execFileAsync as ExecFileFn);
    this.spawnSubprocess = deps.spawnSubprocess ?? spawnCodexAppServer;
  }

  async isAvailable(): Promise<boolean> {
    if (_availabilityCache) return _availabilityCache;
    _availabilityCache = this.detectCodexBinary();
    return _availabilityCache;
  }

  capabilities(): ProviderCapabilities {
    return flavorCapabilities('codex');
  }

  streamChat(params: StreamChatParams): StreamChatResult {
    const eventAdapter = new CodexEventAdapter();
    let abortCtrl: AbortController | null = new AbortController();
    let activeThreadId: string | null = null;
    let activeTurnId: string | null = null;
    let client: CodexAppServerClient | null = null;

    const stream = new ReadableStream<CanonicalEvent>({
      start: async (controller) => {
        const child = this.spawnSubprocess();
        const transport = new StdioJsonlTransport(child);
        client = new CodexAppServerClient(transport);

        const forward = (method: string) => {
          client!.onNotification(method, (p) => {
            const events = eventAdapter.handle(method, p);
            events.forEach((e) => controller.enqueue(e));
          });
        };
        [
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
        ].forEach(forward);

        transport.onExit(({ code }) => {
          if (code !== 0) {
            controller.enqueue({
              kind: 'error',
              message: `Codex app-server exited unexpectedly (code ${code})`,
            });
          }
          controller.close();
        });

        const approvalBridge = new CodexApprovalBridge(client, eventAdapter, params.onPermissionRequest);
        approvalBridge.wireHandlers();

        try {
          await client.initialize({ capabilities: {} });

          if (params.sessionId) {
            const resumeResult = await client.request<
              { threadId: string; cwd?: string; model?: string },
              { thread: { id: string } }
            >('thread/resume', {
              threadId: params.sessionId,
              cwd: params.workingDirectory,
              model: params.model,
            });
            activeThreadId = resumeResult.thread.id;
          } else {
            const startResult = await client.request<
              { cwd?: string; model?: string },
              { thread: { id: string } }
            >('thread/start', {
              cwd: params.workingDirectory,
              model: params.model,
            });
            activeThreadId = startResult.thread.id;
          }

          const turnResult = await client.request<
            { threadId: string; input: Array<{ type: 'text'; text: string }>; effort?: string; model?: string },
            { turn: { id: string } }
          >('turn/start', {
            threadId: activeThreadId,
            input: [{ type: 'text', text: params.prompt }],
            effort: params.effort,
            model: params.model,
          });
          activeTurnId = turnResult.turn.id;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          controller.enqueue({ kind: 'error', message });
          controller.close();
        }
      },
      cancel: () => {
        if (client && activeThreadId && activeTurnId) {
          client.request('turn/interrupt', { threadId: activeThreadId, turnId: activeTurnId }).catch(() => {});
        }
      },
    });

    const controls: QueryControls = {
      interrupt: async () => {
        if (client && activeThreadId && activeTurnId) {
          // Fire-and-forget: don't await — server may not reply before closing
          client.request('turn/interrupt', { threadId: activeThreadId, turnId: activeTurnId }).catch(() => {});
        }
        abortCtrl?.abort();
      },
      stopTask: async (_taskId: string) => {
        if (client && activeThreadId && activeTurnId) {
          client.request('turn/interrupt', { threadId: activeThreadId, turnId: activeTurnId }).catch(() => {});
        }
        abortCtrl?.abort();
      },
    };

    return { stream, controls };
  }

  private async detectCodexBinary(): Promise<boolean> {
    try {
      const { stdout } = await this.execFile('codex', ['--version']);
      const match = stdout.match(/codex-cli\s+(\d+\.\d+\.\d+)/);
      if (!match) return false;
      return compareVersions(match[1], MIN_CODEX_VERSION) >= 0;
    } catch {
      return false;
    }
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
export function spawnCodexAppServer(): ChildProcess {
  return spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}
