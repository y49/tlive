/**
 * LLM Provider using @anthropic-ai/claude-agent-sdk query() function.
 * Based on Claude-to-IM-skill's implementation.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAdapter } from '../messages/claude-adapter.js';
import type { CanonicalEvent } from '../messages/schema.js';
import type { LLMProvider, StreamChatParams, StreamChatResult, QueryControls, ProviderCapabilities, LiveSession } from './base.js';
import { ClaudeLiveSession } from './claude-live-session.js';
import type { PendingPermissions } from '../permissions/gateway.js';
import type { ClaudeSettingSource } from '../config.js';
import { buildSubprocessEnv, preparePromptWithImages, SAFE_PERMISSIONS, classifyAuthError } from './claude-shared.js';

// ── CLI discovery and version check ──

function findClaudeCli(): string | undefined {
  // Check CTI_CLAUDE_CODE_EXECUTABLE env var first
  const fromEnv = process.env.CTI_CLAUDE_CODE_EXECUTABLE;
  if (fromEnv) return fromEnv;

  // Try `which claude` (or `where claude` on Windows)
  const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
  try {
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
    // `where` on Windows may return multiple lines; take the first
    const found = result.split('\n')[0]?.trim();
    if (!found) return undefined;

    // On Windows, npm-installed Claude Code exposes a cmd/ps1 wrapper (no
    // extension) that isn't a native binary. The SDK's query() tries to
    // spawn it directly and gets ENOENT. Resolve to the actual cli.js
    // inside the package so the SDK uses `node cli.js` instead.
    if (process.platform === 'win32') {
      const cliJs = join(dirname(found), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      if (existsSync(cliJs)) return cliJs;
    }

    return found;
  } catch {
    return undefined;
  }
}

function checkCliVersion(cliPath: string): { ok: boolean; version?: string; error?: string } {
  try {
    // On Windows, .js files are associated with Windows Script Host, not Node.
    // Prefix with "node" to avoid triggering wscript.exe.
    const cmd = cliPath.endsWith('.js') ? `node "${cliPath}" --version` : `"${cliPath}" --version`;
    const version = execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim();
    const match = version.match(/(\d+)\.\d+/);
    if (!match || parseInt(match[1]) < 2) {
      return { ok: false, version, error: `Claude CLI ${version} too old (need >= 2.x)` };
    }
    return { ok: true, version };
  } catch {
    return { ok: false, error: 'Failed to run claude --version' };
  }
}

// ── StreamState ──

interface StreamState {
  hasReceivedResult: boolean;
  hasStreamedText: boolean;
  lastAssistantText: string;
}

export type PermissionTimeoutCallback = (toolName: string, toolUseId: string) => void;

export class ClaudeSDKProvider implements LLMProvider {
  private pendingPerms: PendingPermissions;
  private cliPath: string | undefined;
  private settingSources: ClaudeSettingSource[];

  /** Called when a permission request times out — set by main.ts to send IM notifications */
  onPermissionTimeout?: PermissionTimeoutCallback;

  constructor(pendingPerms: PendingPermissions, settingSources?: ClaudeSettingSource[]) {
    this.pendingPerms = pendingPerms;
    this.settingSources = settingSources?.length ? [...settingSources] : ['user'];

    // Preflight check
    this.cliPath = findClaudeCli();
    if (this.cliPath) {
      const check = checkCliVersion(this.cliPath);
      if (!check.ok) {
        console.warn(`[tlive:sdk] CLI preflight warning: ${check.error}`);
      } else {
        console.log(`[tlive:sdk] Using Claude CLI ${check.version} at ${this.cliPath}`);
      }
    } else {
      console.warn('[tlive:sdk] Claude CLI not found — SDK will use default resolution');
    }

    const srcLabel = this.settingSources.length > 0 ? this.settingSources.join(', ') : 'none (isolation mode)';
    console.log(`[tlive:sdk] Settings sources: ${srcLabel}`);
  }

  getSettingSources(): ClaudeSettingSource[] {
    return [...this.settingSources];
  }

  setSettingSources(sources: ClaudeSettingSource[]): void {
    this.settingSources = [...sources];
    const label = sources.length > 0 ? sources.join(', ') : 'none (isolation mode)';
    console.log(`[tlive:sdk] Settings sources changed: ${label}`);
  }

  capabilities(): ProviderCapabilities {
    return {
      slashCommands: true,
      askUserQuestion: true,
      liveSession: true,
      todoTracking: true,
      costInUsd: true,
      skills: true,
      sessionResume: true,
    };
  }

  createSession(params: { workingDirectory: string; sessionId?: string; effort?: 'low' | 'medium' | 'high' | 'max'; model?: string }): LiveSession {
    return new ClaudeLiveSession({
      workingDirectory: params.workingDirectory,
      sessionId: params.sessionId,
      cliPath: this.cliPath,
      settingSources: this.settingSources,
      pendingPerms: this.pendingPerms,
      onPermissionTimeout: this.onPermissionTimeout,
      effort: params.effort,
      model: params.model,
    });
  }

  streamChat(params: StreamChatParams): StreamChatResult {
    const pendingPerms = this.pendingPerms;
    const cliPath = this.cliPath;
    const onPermissionTimeout = this.onPermissionTimeout;
    const settingSources = this.settingSources;

    // Query controls exposed for interrupt/stopTask
    let controls: QueryControls | undefined;

    const stream = new ReadableStream<CanonicalEvent>({
      start(controller) {
        (async () => {
          const state: StreamState = {
            hasReceivedResult: false,
            hasStreamedText: false,
            lastAssistantText: '',
          };

          let stderrBuf = '';

          try {
            const prompt = preparePromptWithImages(params.prompt, params.attachments);

            const queryOptions: Record<string, unknown> = {
              cwd: params.workingDirectory,
              model: params.model || undefined,
              resume: params.sessionId || undefined,
              permissionMode: params.permissionMode || undefined,
              effort: params.effort || undefined,
              // Enable AI-generated progress summaries for subagents (~30s interval)
              agentProgressSummaries: true,
              // Enable prompt suggestions (predicted next user prompt after each turn)
              promptSuggestions: true,
              // Enable markdown previews in AskUserQuestion options
              toolConfig: {
                askUserQuestion: { previewFormat: 'markdown' },
              },
              // Controls which Claude Code settings files to load.
              // Default ['user'] loads ~/.claude/settings.json (auth, model).
              // Add 'project' for CLAUDE.md, MCP, skills; 'local' for dev overrides.
              // Empty array = full isolation (SDK default).
              // Configured via TL_CLAUDE_SETTINGS env var.
              settingSources,
              // Use Claude Code's native permission rules for fine-grained control.
              // Safe read-only tools + safe Bash patterns are pre-approved.
              // Dangerous operations (write, delete, network) still trigger canUseTool.
              // These are passed as flag settings (highest priority), so they override
              // any permission rules from user's settings.json.
              settings: { permissions: { allow: SAFE_PERMISSIONS } },
              env: buildSubprocessEnv(),
              stderr: (data: string) => {
                stderrBuf += data;
                if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
              },
              abortController: params.abortSignal
                ? Object.assign(new AbortController(), { signal: params.abortSignal })
                : undefined,
              canUseTool: async (
                toolName: string,
                input: Record<string, unknown>,
                options: { decisionReason?: string; title?: string; suggestions?: unknown[]; signal?: AbortSignal; blockedPath?: string; toolUseID?: string; agentID?: string } = {},
              ): Promise<PermissionResult> => {
                // AskUserQuestion — route to dedicated handler
                // NOTE: We intentionally do NOT pass the abort signal to the IM handler.
                // IM users may respond hours later; the SDK's abort signal should not
                // cancel a question the user hasn't even seen yet.
                if (toolName === 'AskUserQuestion' && params.onAskUserQuestion) {
                  const questions = (input as Record<string, unknown>).questions as Array<{
                    question: string;
                    header: string;
                    options: Array<{ label: string; description?: string; preview?: string }>;
                    multiSelect: boolean;
                  }> ?? [];
                  if (questions.length > 0) {
                    try {
                      const answers = await params.onAskUserQuestion(questions);
                      return {
                        behavior: 'allow' as const,
                        updatedInput: { questions: (input as Record<string, unknown>).questions, answers },
                      };
                    } catch {
                      return { behavior: 'deny' as const, message: 'User did not answer' };
                    }
                  }
                }
                // If no handler (perm off) → auto-allow
                if (!params.onPermissionRequest) {
                  return { behavior: 'allow' as const, updatedInput: input };
                }
                // NOTE: We intentionally ignore options.signal?.aborted here.
                // In IM context, the user may not be at the keyboard — the abort signal
                // should not auto-deny a permission the user hasn't seen yet.
                const reason = options.blockedPath
                  ? `${options.decisionReason || toolName} (${options.blockedPath})`
                  : (options.decisionReason || options.title || toolName);
                console.log(`[tlive:sdk] canUseTool: ${toolName} → asking user (${reason})`);
                // Do not pass abort signal — IM permissions wait indefinitely for user response
                const decision = await params.onPermissionRequest(toolName, input, reason);
                if (decision === 'allow') {
                  return { behavior: 'allow' as const, updatedInput: input, toolUseID: options.toolUseID };
                }
                if (decision === 'allow_always') {
                  // SDK API uses behavior:'allow' + updatedPermissions to persist the rule.
                  // 'allow_always' is our internal concept, mapped to SDK's permission update mechanism.
                  return {
                    behavior: 'allow' as const,
                    updatedInput: input,
                    toolUseID: options.toolUseID,
                    ...(options.suggestions ? { updatedPermissions: options.suggestions } : {}),
                  } as PermissionResult;
                }
                return { behavior: 'deny' as const, message: 'Denied by user via IM', toolUseID: options.toolUseID };
              },
            };

            if (cliPath) {
              queryOptions.pathToClaudeCodeExecutable = cliPath;
            }

            const q = query({
              prompt: prompt as Parameters<typeof query>[0]['prompt'],
              options: queryOptions as Parameters<typeof query>[0]['options'],
            });

            // Expose query controls for interrupt/stopTask
            controls = {
              interrupt: async () => { await (q as any).interrupt?.(); },
              stopTask: async (taskId: string) => { await (q as any).stopTask?.(taskId); },
            };

            const adapter = new ClaudeAdapter();

            for await (const msg of q) {
              const sub = 'subtype' in msg ? `.${msg.subtype}` : '';
              const turns = 'num_turns' in msg ? ` turns=${msg.num_turns}` : '';
              console.log(`[tlive:sdk] msg: ${msg.type}${sub}${turns}`);

              const events = adapter.mapMessage(msg as any);
              for (const event of events) {
                controller.enqueue(event);
              }

              // Track state for error handling
              if (msg.type === 'result') state.hasReceivedResult = true;
              if (events.some(e => e.kind === 'text_delta')) state.hasStreamedText = true;
              for (const event of events) {
                if (event.kind === 'text_delta') state.lastAssistantText += event.text;
              }
            }

            console.log(`[tlive:sdk] query ended. streamed=${state.hasStreamedText} text_len=${state.lastAssistantText.length}`);
            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            // Check for auth errors first
            const authType = classifyAuthError(message) || (stderrBuf ? classifyAuthError(stderrBuf) : false);
            if (authType === 'cli') {
              console.error('[tlive:sdk] Auth error: not logged in. Run `claude /login` to authenticate.');
              controller.enqueue({ kind: 'error', message: 'Not logged in. Run `claude /login` to authenticate.' } as CanonicalEvent);
              controller.close();
              return;
            }
            if (authType === 'api') {
              console.error('[tlive:sdk] Auth error: invalid API key or unauthorized.');
              controller.enqueue({ kind: 'error', message: 'Invalid API key or unauthorized. Check your credentials.' } as CanonicalEvent);
              controller.close();
              return;
            }

            // If result was already received, this is just transport teardown noise
            if (state.hasReceivedResult && message.includes('process exited with code')) {
              controller.close();
              return;
            }

            const diagInfo = stderrBuf ? ` [stderr: ${stderrBuf.slice(-200)}]` : '';
            console.error(`[tlive:sdk] query error: ${message}${diagInfo}`);

            controller.enqueue({ kind: 'error', message } as CanonicalEvent);
            controller.close();
          }
        })();
      },
    });

    return { stream, controls };
  }
}

