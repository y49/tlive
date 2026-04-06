/**
 * LLM Provider using @anthropic-ai/claude-agent-sdk query() function.
 * Based on Claude-to-IM-skill's implementation.
 */

import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAdapter } from '../messages/claude-adapter.js';
import type { CanonicalEvent } from '../messages/schema.js';
import type { LLMProvider, StreamChatParams, StreamChatResult, QueryControls } from './base.js';
import type { PendingPermissions } from '../permissions/gateway.js';
import type { ClaudeSettingSource } from '../config.js';

// ── Auth error classification ──

const CLI_AUTH_PATTERNS = [/not logged in/i, /please run \/login/i];
const API_AUTH_PATTERNS = [/unauthorized/i, /invalid.*api.?key/i, /401\b/];

function classifyAuthError(text: string): 'cli' | 'api' | false {
  if (CLI_AUTH_PATTERNS.some(re => re.test(text))) return 'cli';
  if (API_AUTH_PATTERNS.some(re => re.test(text))) return 'api';
  return false;
}

// ── Environment isolation ──

const ENV_ALWAYS_STRIP = ['CLAUDECODE'];

function buildSubprocessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_ALWAYS_STRIP.some(prefix => k.startsWith(prefix))) continue;
    out[k] = v;
  }
  return out;
}

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
        console.warn(`[claude-sdk] CLI preflight warning: ${check.error}`);
      } else {
        console.log(`[claude-sdk] Using Claude CLI ${check.version} at ${this.cliPath}`);
      }
    } else {
      console.warn('[claude-sdk] Claude CLI not found — SDK will use default resolution');
    }

    const srcLabel = this.settingSources.length > 0 ? this.settingSources.join(', ') : 'none (isolation mode)';
    console.log(`[claude-sdk] Settings sources: ${srcLabel}`);
  }

  getSettingSources(): ClaudeSettingSource[] {
    return [...this.settingSources];
  }

  setSettingSources(sources: ClaudeSettingSource[]): void {
    this.settingSources = [...sources];
    const label = sources.length > 0 ? sources.join(', ') : 'none (isolation mode)';
    console.log(`[claude-sdk] Settings sources changed: ${label}`);
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
            // Save image attachments to temp files so Claude Code can read them
            let prompt = params.prompt;
            if (params.attachments?.length) {
              const imgDir = join(tmpdir(), 'tlive-images');
              mkdirSync(imgDir, { recursive: true });
              const imagePaths: string[] = [];
              for (const att of params.attachments) {
                if (att.type === 'image') {
                  const ext = att.mimeType === 'image/png' ? '.png' : att.mimeType === 'image/gif' ? '.gif' : '.jpg';
                  const filePath = join(imgDir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`);
                  writeFileSync(filePath, Buffer.from(att.base64Data, 'base64'));
                  imagePaths.push(filePath);
                }
              }
              if (imagePaths.length > 0) {
                const imageRefs = imagePaths.map(p => p).join('\n');
                prompt = `[User sent ${imagePaths.length} image(s) — read them to see the content]\n${imageRefs}\n\n${prompt}`;
              }
            }

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
              settings: {
                permissions: {
                  allow: [
                    // Read-only tools — always safe
                    'Read(*)', 'Glob(*)', 'Grep(*)', 'WebSearch(*)', 'WebFetch(*)',
                    'Agent(*)', 'Task(*)', 'TodoRead(*)', 'ToolSearch(*)',
                    // Safe Bash commands — read-only, no side effects
                    'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(less *)',
                    'Bash(wc *)', 'Bash(ls *)', 'Bash(tree *)', 'Bash(find *)',
                    'Bash(grep *)', 'Bash(rg *)', 'Bash(ag *)',
                    'Bash(file *)', 'Bash(stat *)', 'Bash(du *)', 'Bash(df *)',
                    'Bash(which *)', 'Bash(type *)', 'Bash(whereis *)',
                    'Bash(echo *)', 'Bash(printf *)', 'Bash(date *)',
                    'Bash(pwd)', 'Bash(whoami)', 'Bash(uname *)', 'Bash(env)',
                    'Bash(git log *)', 'Bash(git status *)', 'Bash(git diff *)',
                    'Bash(git show *)', 'Bash(git blame *)', 'Bash(git branch *)',
                    'Bash(node -v *)', 'Bash(npm list *)', 'Bash(npx tsc *)',
                    'Bash(go version *)', 'Bash(go list *)',
                  ],
                },
              },
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
                options: { decisionReason?: string; title?: string; suggestions?: unknown[]; signal?: AbortSignal } = {},
              ): Promise<PermissionResult> => {
                // AskUserQuestion — route to dedicated handler
                // NOTE: We intentionally do NOT pass the abort signal to the IM handler.
                // IM users may respond hours later; the SDK's abort signal should not
                // cancel a question the user hasn't even seen yet.
                if (toolName === 'AskUserQuestion' && params.onAskUserQuestion) {
                  const questions = (input as Record<string, unknown>).questions as Array<{
                    question: string;
                    header: string;
                    options: Array<{ label: string; description?: string }>;
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
                const reason = options.decisionReason || options.title || toolName;
                console.log(`[claude-sdk] canUseTool: ${toolName} → asking user (${reason})`);
                // Do not pass abort signal — IM permissions wait indefinitely for user response
                const decision = await params.onPermissionRequest(toolName, input, reason);
                if (decision === 'allow') {
                  return { behavior: 'allow' as const, updatedInput: input };
                }
                if (decision === 'allow_always') {
                  // SDK API uses behavior:'allow' + updatedPermissions to persist the rule.
                  // 'allow_always' is our internal concept, mapped to SDK's permission update mechanism.
                  return {
                    behavior: 'allow' as const,
                    updatedInput: input,
                    ...(options.suggestions ? { updatedPermissions: options.suggestions } : {}),
                  } as PermissionResult;
                }
                return { behavior: 'deny' as const, message: 'Denied by user via IM' };
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
              console.log(`[claude-sdk] msg: ${msg.type}${sub}${turns}`);

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

            console.log(`[claude-sdk] query ended. streamed=${state.hasStreamedText} text_len=${state.lastAssistantText.length}`);
            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            // Check for auth errors first
            const authType = classifyAuthError(message) || (stderrBuf ? classifyAuthError(stderrBuf) : false);
            if (authType === 'cli') {
              console.error('[claude-sdk] Auth error: not logged in. Run `claude /login` to authenticate.');
              controller.enqueue({ kind: 'error', message: 'Not logged in. Run `claude /login` to authenticate.' } as CanonicalEvent);
              controller.close();
              return;
            }
            if (authType === 'api') {
              console.error('[claude-sdk] Auth error: invalid API key or unauthorized.');
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
            console.error(`[claude-sdk] query error: ${message}${diagInfo}`);

            controller.enqueue({ kind: 'error', message } as CanonicalEvent);
            controller.close();
          }
        })();
      },
    });

    return { stream, controls };
  }
}

