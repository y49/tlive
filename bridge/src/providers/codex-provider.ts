/**
 * LLM Provider using @openai/codex-sdk.
 * Gracefully degrades if the SDK is not installed (platform-specific binaries).
 */

import type { LLMProvider, StreamChatParams, StreamChatResult, QueryControls, ProviderCapabilities } from './base.js';
import type { CanonicalEvent } from '../messages/schema.js';
import { CodexAdapter } from '../messages/codex-adapter.js';

// Re-export SDK types for use by adapter and commands
export type {
  Codex as CodexClass,
  CodexOptions,
  ThreadOptions,
  ThreadEvent,
  ThreadItem,
  ApprovalMode,
  SandboxMode,
  ModelReasoningEffort,
} from '@openai/codex-sdk';

// ── Effort mapping ──
// Bridge uses Claude-style levels; Codex SDK has its own scale.
const EFFORT_MAP: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'xhigh',
};

// ── Auth error classification ──
const AUTH_PATTERNS = [/invalid.*api.?key/i, /unauthorized/i, /401\b/, /OPENAI_API_KEY/i, /authentication/i];

function isAuthError(text: string): boolean {
  return AUTH_PATTERNS.some(re => re.test(text));
}

// ── Environment for subprocess ──
function buildCodexEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export class CodexProvider implements LLMProvider {
  private CodexCtor: any;
  private _available = false;
  private _initPromise: Promise<void>;

  constructor() {
    // Async import — Codex SDK is pure ESM, require() doesn't work
    this._initPromise = import('@openai/codex-sdk')
      .then((mod) => {
        this.CodexCtor = mod.Codex || (mod as any).default?.Codex;
        this._available = !!this.CodexCtor;
        if (this._available) {
          console.log('[tlive:codex] Codex SDK available');
        }
      })
      .catch(() => {
        console.warn('[tlive:codex] @openai/codex-sdk not installed — Codex provider unavailable');
      });
  }

  isAvailable(): boolean {
    return this._available;
  }

  /** Wait for async SDK import to complete */
  async ensureInit(): Promise<boolean> {
    await this._initPromise;
    return this._available;
  }

  capabilities(): ProviderCapabilities {
    return {
      slashCommands: false,
      askUserQuestion: false,
      liveSession: false,
      todoTracking: false,
      costInUsd: false,
      skills: false,
      sessionResume: true,
    };
  }

  streamChat(params: StreamChatParams): StreamChatResult {
    if (!this._available) {
      const stream = new ReadableStream<CanonicalEvent>({
        start(controller) {
          controller.enqueue({
            kind: 'error',
            message: 'Codex SDK not installed. Run: npm install @openai/codex-sdk',
          } as CanonicalEvent);
          controller.close();
        },
      });
      return { stream };
    }

    const adapter = new CodexAdapter();
    let abortController: AbortController | undefined;

    const stream = new ReadableStream<CanonicalEvent>({
      start: (controller) => {
        (async () => {
          try {
            // Ensure async SDK import is done
            await this._initPromise;
            if (!this._available) {
              controller.enqueue({ kind: 'error', message: 'Codex SDK not installed. Run: npm install @openai/codex-sdk' } as CanonicalEvent);
              controller.close();
              return;
            }

            const codex = new this.CodexCtor({
              apiKey: process.env.OPENAI_API_KEY,
              env: buildCodexEnv(),
            });

            // Map permission mode → approval policy + sandbox mode
            // /perm on  → untrusted (ask user) + workspace-write
            // /perm off → on-failure (auto-approve) + workspace-write
            const approvalPolicy = params.onPermissionRequest
              ? 'untrusted'
              : 'on-failure';

            const threadOptions: Record<string, unknown> = {
              model: params.model || process.env.CODEX_MODEL || undefined,
              workingDirectory: params.workingDirectory,
              approvalPolicy,
              sandboxMode: 'workspace-write',
              // Map effort: low/medium/high/max → Codex's minimal/low/medium/high/xhigh
              ...(params.effort ? { modelReasoningEffort: EFFORT_MAP[params.effort] || params.effort } : {}),
            };

            let thread: any;
            let resumed = false;
            if (params.sessionId) {
              thread = codex.resumeThread(params.sessionId, threadOptions);
              resumed = true;
            } else {
              thread = codex.startThread(threadOptions);
            }

            abortController = new AbortController();
            let streamResult: { events: AsyncGenerator<any> };
            try {
              streamResult = await thread.runStreamed(params.prompt, {
                signal: abortController.signal,
              });
            } catch (resumeErr) {
              // If resume failed (thread expired/not found), retry with new thread
              if (resumed) {
                console.warn(`[tlive:codex] Resume failed (${resumeErr instanceof Error ? resumeErr.message : resumeErr}), starting new thread`);
                thread = codex.startThread(threadOptions);
                streamResult = await thread.runStreamed(params.prompt, {
                  signal: abortController.signal,
                });
              } else {
                throw resumeErr;
              }
            }
            const { events } = streamResult;

            for await (const event of events) {
              const itemType = 'item' in event ? `.${(event as any).item?.type}` : '';
              console.log(`[tlive:codex] event: ${event.type}${itemType}`);
              const canonicalEvents = adapter.adapt(event);
              for (const ce of canonicalEvents) {
                controller.enqueue(ce);
              }
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            // Auth error detection
            if (isAuthError(message)) {
              console.error('[tlive:codex] Auth error: invalid API key or unauthorized.');
              controller.enqueue({
                kind: 'error',
                message: 'Invalid OpenAI API key. Check OPENAI_API_KEY in ~/.tlive/config.env or environment.',
              } as CanonicalEvent);
              controller.close();
              return;
            }

            console.error(`[tlive:codex] Error: ${message}`);
            controller.enqueue({ kind: 'error', message } as CanonicalEvent);
            controller.close();
          }
        })();
      },
    });

    const controls: QueryControls = {
      interrupt: async () => { abortController?.abort(); },
      stopTask: async () => { abortController?.abort(); },
    };

    return { stream, controls };
  }
}
