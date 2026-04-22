// src/runtime/claude/event-adapter.ts
//
// Maps raw Claude Agent SDK stream messages (SDKMessage union) to NotificationEvent
// per spec §3.4. Maintains per-turn state (current turnId, turnStartedAt) plus
// parallel-batch tracking so tool_use_start events carry batchId/batchIndex when
// an assistant reply contains multiple tool_use blocks.
//
// Only the event-translation surface lives here. PermissionRequest /
// AskUserQuestionRequest / ElicitationRequest flow through the canPermissionUse
// + onAskUserQuestion + onElicitation callbacks on the SDK Query and are
// installed by ClaudeSdkRuntime directly; this adapter emits the companion
// notification events (`permission_requested`, `ask_user_question_requested`,
// `elicitation_requested`) on demand from the runtime.

import { randomBytes } from 'node:crypto';
import type { NotificationEvent, UsageStats } from '../events.js';
import type { AskUserQuestionRequest } from '../types.js';

type SdkMessage = { type: string; [k: string]: unknown };

export interface AdaptedFrame {
  events: NotificationEvent[];
  usage?: UsageStats;
  askUserQuestion?: AskUserQuestionRequest;
}

export class ClaudeEventAdapter {
  private currentTurnId: string | null = null;
  private turnStartedAt = 0;
  private currentBatchId: string | null = null;
  private currentBatchSize = 0;
  private currentBatchIndex = 0;

  /** Raw SDK turnId getter for runtime coordination. */
  getCurrentTurnId(): string | null { return this.currentTurnId; }

  adapt(msg: SdkMessage): AdaptedFrame {
    const events: NotificationEvent[] = [];
    let usage: UsageStats | undefined;
    let askUserQuestion: AskUserQuestionRequest | undefined;

    const sub = (msg as { subtype?: string }).subtype;

    switch (msg.type) {
      case 'system': {
        // SDKSystemMessage / SDKCompactBoundaryMessage / hook_* / task_* /
        // files_persisted / elicitation_complete / auth_status all arrive
        // with type === 'system' and a discriminating subtype.
        if (sub === 'init') break; // consumed by runtime to capture sdkSessionId
        if (sub === 'compact_boundary') {
          const meta = (msg as { compact_metadata?: { trigger?: string; pre_tokens?: number } }).compact_metadata;
          events.push({
            kind: 'pre_compact',
            droppedMessages: 0,
            keptMessages: 0,
          });
          if (meta && typeof meta.pre_tokens === 'number') {
            events.push({ kind: 'post_compact', tokensSaved: meta.pre_tokens });
          }
          break;
        }
        if (sub === 'task_started') {
          const p = msg as { task_id?: string; description?: string };
          events.push({
            kind: 'subagent_start',
            agentId: String(p.task_id ?? ''),
            parentTurnId: this.currentTurnId ?? 'unknown',
            description: String(p.description ?? ''),
            taskId: String(p.task_id ?? ''),
          });
          break;
        }
        if (sub === 'task_progress') {
          const p = msg as { task_id?: string; summary?: string; description?: string };
          events.push({
            kind: 'subagent_progress',
            agentId: String(p.task_id ?? ''),
            summary: String(p.summary ?? p.description ?? ''),
          });
          break;
        }
        if (sub === 'task_notification') {
          const p = msg as { task_id?: string; status?: string };
          const ok = p.status === 'completed';
          events.push({
            kind: 'subagent_stop',
            agentId: String(p.task_id ?? ''),
            taskId: String(p.task_id ?? ''),
            ok,
          });
          break;
        }
        if (sub === 'hook_started' || sub === 'hook_progress' || sub === 'hook_response') {
          const hookEvent = String((msg as { hook_event?: string }).hook_event ?? 'hook');
          events.push(...adaptHookEvent(hookEvent, msg));
          break;
        }
        if (sub === 'files_persisted') {
          const p = msg as { files?: Array<{ filename: string; file_id: string }> };
          for (const f of p.files ?? []) {
            events.push({
              kind: 'file_changed',
              path: String(f.filename),
              op: 'modified',
            });
          }
          break;
        }
        if (sub === 'elicitation_complete') {
          const p = msg as { elicitation_id?: string };
          events.push({
            kind: 'elicitation_resolved',
            requestId: String(p.elicitation_id ?? ''),
            action: 'accept',
          });
          break;
        }
        break;
      }
      case 'user': {
        // New turn boundary — SDK emits a synthetic user replay on resume, so we
        // still issue turn_start. Frontends dedupe against the persisted history.
        const turnId = this.newTurn();
        const content = extractUserText(msg);
        events.push({
          kind: 'turn_start',
          turnId,
          userInputPreview: content.slice(0, 80),
          at: Date.now(),
        });
        break;
      }
      case 'assistant': {
        const parts = extractAssistantContent(msg);
        const toolUseParts = parts.filter((p) => p.type === 'tool_use');
        const isParallel = toolUseParts.length > 1;
        if (isParallel) {
          this.currentBatchId = randomBytes(4).toString('hex');
          this.currentBatchSize = toolUseParts.length;
          this.currentBatchIndex = 0;
          events.push({
            kind: 'parallel_tool_batch_start',
            batchId: this.currentBatchId,
            count: this.currentBatchSize,
          });
        }
        for (const part of parts) {
          if (part.type === 'text') {
            events.push({
              kind: 'assistant_text',
              turnId: this.currentTurnId ?? 'unknown',
              text: String(part.text ?? ''),
              complete: true,
            });
          } else if (part.type === 'tool_use') {
            const ev: Extract<NotificationEvent, { kind: 'tool_use_start' }> = {
              kind: 'tool_use_start',
              turnId: this.currentTurnId ?? 'unknown',
              toolUseId: String(part.id ?? ''),
              toolName: String(part.name ?? ''),
              input: part.input,
            };
            if (isParallel && this.currentBatchId) {
              ev.batchId = this.currentBatchId;
              ev.batchIndex = this.currentBatchIndex++;
              ev.batchSize = this.currentBatchSize;
            }
            // TodoWrite is a Claude convention: emit the structured todo_write event.
            if (ev.toolName === 'TodoWrite') {
              const items = extractTodos(part.input);
              if (items) events.push({ kind: 'todo_write', items });
            }
            events.push(ev);
          } else if (part.type === 'thinking') {
            // BetaThinkingContentBlock carries { thinking: string, signature?: string }.
            // Token counts aren't on the block itself; approximate via content length.
            const text = String((part as { thinking?: string }).thinking ?? '');
            if (text) {
              events.push({ kind: 'thinking_delta', turnId: this.currentTurnId ?? 'unknown', text, partial: true });
            }
            events.push({ kind: 'thinking_end', turnId: this.currentTurnId ?? 'unknown', totalTokens: text.length });
          }
        }
        if (isParallel && this.currentBatchId) {
          events.push({ kind: 'parallel_tool_batch_end', batchId: this.currentBatchId });
          this.currentBatchId = null;
          this.currentBatchSize = 0;
          this.currentBatchIndex = 0;
        }
        break;
      }
      case 'stream_event': {
        // SDKPartialAssistantMessage: partial content_block deltas when
        // includePartialMessages: true.
        const delta = extractDelta(msg);
        if (delta?.kind === 'text_delta') {
          events.push({
            kind: 'assistant_text_delta',
            turnId: this.currentTurnId ?? 'unknown',
            text: delta.text,
            partial: true,
          });
        } else if (delta?.kind === 'thinking_delta') {
          events.push({
            kind: 'thinking_delta',
            turnId: this.currentTurnId ?? 'unknown',
            text: delta.text,
            partial: true,
          });
        }
        break;
      }
      case 'result': {
        const raw = msg as {
          total_cost_usd?: number;
          duration_ms?: number;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          subtype?: string;
          is_error?: boolean;
          result?: string;
        };
        const u = raw.usage;
        usage = u ? {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens,
          cacheCreationTokens: u.cache_creation_input_tokens,
          costUsd: raw.total_cost_usd ?? 0,
        } : undefined;
        const turnId = this.currentTurnId ?? 'unknown';
        const duration = raw.duration_ms ?? (this.turnStartedAt ? Date.now() - this.turnStartedAt : 0);
        events.push({
          kind: 'turn_end',
          turnId,
          durationMs: duration,
          costUsd: usage?.costUsd ?? 0,
          tokensIn: usage?.inputTokens ?? 0,
          tokensOut: usage?.outputTokens ?? 0,
        });
        if (raw.is_error) {
          events.push({
            kind: 'runtime_error',
            severity: 'warn',
            code: String(raw.subtype ?? 'error'),
            message: String(raw.result ?? raw.subtype ?? 'error'),
          });
        }
        break;
      }
      case 'prompt_suggestion': {
        const p = msg as { suggestion?: string };
        events.push({
          kind: 'prompt_suggestion',
          turnId: this.currentTurnId ?? 'unknown',
          suggestions: p.suggestion ? [{ id: randomBytes(2).toString('hex'), text: String(p.suggestion) }] : [],
        });
        break;
      }
      case 'rate_limit_event': {
        const p = msg as { rate_limit_info?: { status?: string; resetsAt?: number } };
        const info = p.rate_limit_info;
        if (info?.status === 'rejected') {
          const retry = info.resetsAt ? Math.max(0, info.resetsAt * 1000 - Date.now()) : 0;
          events.push({ kind: 'api_throttle', retryAfterMs: retry, message: 'rate limit' });
        } else if (info?.status === 'allowed') {
          events.push({ kind: 'api_resumed' });
        }
        break;
      }
      case 'api_retry': {
        const p = msg as { retry_delay_ms?: number; error?: string };
        events.push({
          kind: 'api_throttle',
          retryAfterMs: Number(p.retry_delay_ms ?? 0),
          message: String(p.error ?? 'api retry'),
        });
        break;
      }
      case 'tool_progress': {
        // Fine-grained tool progress — no dedicated event kind; runtime may surface
        // as heartbeat/subagent_progress depending on context. For now, swallow.
        break;
      }
      case 'tool_use_summary': {
        // Summary of tool use after completion. Represented downstream via tool_use_result.
        break;
      }
      case 'session_state_changed': {
        // Transient SDK state hint — consumed by runtime/status-machine, not
        // mapped to a user-facing event here.
        break;
      }
    }

    return { events, usage, askUserQuestion };
  }

  private newTurn(): string {
    this.currentTurnId = randomBytes(4).toString('hex');
    this.turnStartedAt = Date.now();
    return this.currentTurnId;
  }
}

// ---- helpers -------------------------------------------------------------

function extractUserText(msg: { [k: string]: unknown }): string {
  const m = msg.message as { content?: unknown } | undefined;
  if (typeof m?.content === 'string') return m.content;
  if (Array.isArray(m?.content)) {
    return m.content
      .map((c: unknown) => (c as { type?: string; text?: string })?.text ?? '')
      .join(' ');
  }
  return '';
}

function extractAssistantContent(
  msg: { [k: string]: unknown },
): Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown; thinking?: string }> {
  const m = msg.message as { content?: unknown } | undefined;
  const parts = Array.isArray(m?.content) ? m.content : [];
  return parts as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown; thinking?: string }>;
}

function extractDelta(msg: { [k: string]: unknown }): { kind: 'text_delta' | 'thinking_delta'; text: string } | null {
  const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } } }).event;
  const t = ev?.delta?.type;
  if (t === 'text_delta') return { kind: 'text_delta', text: String(ev?.delta?.text ?? '') };
  if (t === 'thinking_delta') return { kind: 'thinking_delta', text: String(ev?.delta?.thinking ?? ev?.delta?.text ?? '') };
  return null;
}

function adaptHookEvent(event: string, msg: { [k: string]: unknown }): NotificationEvent[] {
  // Only FileChanged-like hook events map to structured `file_changed`; everything
  // else is opaque from the adapter's perspective, so we stash the whole message
  // in hook_generic for renderer-side inspection.
  if (event === 'FileChanged' || event === 'PostToolUse:Edit' || event === 'PostToolUse:Write') {
    const p = msg as {
      specific_output?: { path?: string; op?: 'created' | 'modified' | 'deleted'; diff?: string; user_message_id?: string };
    };
    if (p.specific_output?.path) {
      return [{
        kind: 'file_changed',
        path: String(p.specific_output.path),
        op: p.specific_output.op ?? 'modified',
        diff: p.specific_output.diff,
        userMessageId: p.specific_output.user_message_id,
      }];
    }
  }
  return [{ kind: 'hook_generic', event, payload: msg }];
}

function extractTodos(
  input: unknown,
): Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; id?: string }> | null {
  if (!input || typeof input !== 'object') return null;
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return null;
  const out: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; id?: string }> = [];
  for (const t of todos) {
    if (t && typeof t === 'object' && 'content' in t && 'status' in t) {
      const st = (t as { status: string }).status;
      if (st !== 'pending' && st !== 'in_progress' && st !== 'completed') continue;
      out.push({
        content: String((t as { content: unknown }).content),
        status: st,
        id: typeof (t as { id?: unknown }).id === 'string' ? (t as { id: string }).id : undefined,
      });
    }
  }
  return out.length > 0 ? out : null;
}
