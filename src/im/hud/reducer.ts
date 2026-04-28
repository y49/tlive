// src/im/hud/reducer.ts
//
// applyEventToHudState — single mutation entry point for HudState.
// Pure function: returns the same reference if the event is a no-op so
// callers can short-circuit on identity.

import type { NotificationEvent } from '../../runtime/events.js';
import type {
  HudState, HudActivity, HudSubagent, HudTodo,
} from './state.js';

const TOOL_ARG_PREVIEW_MAX = 60;

function previewArg(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === 'string') return clamp(input);
  if (typeof input !== 'object') return clamp(String(input));
  const obj = input as Record<string, unknown>;
  // Most-useful field first.
  const candidates = ['file_path', 'path', 'pattern', 'command', 'url', 'query'];
  for (const k of candidates) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return clamp(basenameLike(v));
  }
  return undefined;
}

function basenameLike(s: string): string {
  if (!s.includes('/')) return s;
  const parts = s.split('/');
  // Show last 2 segments so '/abs/path/README.md' → 'path/README.md'.
  return parts.slice(-2).join('/');
}

function clamp(s: string): string {
  return s.length <= TOOL_ARG_PREVIEW_MAX ? s : s.slice(0, TOOL_ARG_PREVIEW_MAX - 1) + '…';
}

function incTally(tally: ReadonlyMap<string, number>, name: string): ReadonlyMap<string, number> {
  const next = new Map(tally);
  next.set(name, (next.get(name) ?? 0) + 1);
  return next;
}

function mapTodos(items: ReadonlyArray<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>): ReadonlyArray<HudTodo> {
  return items.map(i => ({
    text: i.content,
    status: i.status === 'completed' ? 'done' : i.status,
  }));
}

export function applyEventToHudState(state: HudState, ev: NotificationEvent): HudState {
  switch (ev.kind) {
    case 'turn_start': {
      const activity: HudActivity = { kind: 'thinking', elapsedMs: 0 };
      return { ...state, currentActivity: activity };
    }
    case 'tool_use_start': {
      const activity: HudActivity = {
        kind: 'tool_running',
        toolName: ev.toolName,
        toolArg: previewArg(ev.input),
        elapsedMs: 0,
      };
      return { ...state, currentActivity: activity };
    }
    case 'tool_use_result': {
      const tally = incTally(state.toolTally, lookupToolName(state, ev.toolUseId) ?? 'unknown');
      const next: HudState = {
        ...state,
        toolTally: tally,
        currentActivity: state.currentActivity?.kind === 'tool_running'
          ? { kind: 'thinking', elapsedMs: 0 }
          : state.currentActivity,
      };
      return next;
    }
    case 'subagent_start': {
      const sa: HudSubagent = {
        agentId: ev.agentId,
        name: ev.description,
        status: 'running',
      };
      return { ...state, subagents: [...state.subagents, sa] };
    }
    case 'subagent_stop': {
      return {
        ...state,
        subagents: state.subagents.map(s =>
          s.agentId === ev.agentId
            ? { ...s, status: ev.ok ? 'done_ok' : 'done_err' }
            : s,
        ),
      };
    }
    case 'subagent_progress': {
      return {
        ...state,
        subagents: state.subagents.map(s =>
          s.agentId === ev.agentId ? { ...s, summary: ev.summary } : s,
        ),
      };
    }
    case 'todo_write': {
      return { ...state, todoList: mapTodos(ev.items) };
    }
    case 'turn_end': {
      return {
        ...state,
        currentActivity: null,
        costThisTurn: ev.costUsd,
        costSession: state.costSession + ev.costUsd,
        durationMs: ev.durationMs,
        isFrozen: true,
      };
    }
    case 'runtime_error': {
      if (ev.severity !== 'fatal') return state;
      return { ...state, isErrored: true, errorSummary: ev.message };
    }
    case 'quota_update': {
      return { ...state, quotaBars: ev.quotaBars };
    }
    default:
      return state;
  }
}

// State doesn't track toolUseId → toolName; we keep this as a forward-compat hook.
// For now the reducer can't recover the tool name on tool_use_result, so we let
// the dispatcher feed the tally itself when we have currentActivity set.
function lookupToolName(state: HudState, _toolUseId: string): string | undefined {
  if (state.currentActivity?.kind === 'tool_running') return state.currentActivity.toolName;
  return undefined;
}
