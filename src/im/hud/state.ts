// src/im/hud/state.ts
//
// HudState — single source of truth for per-turn IM HUD content. Platform
// renderers consume this; they MUST NOT add or compute fields not in this
// shape. Mutations always flow through applyEventToHudState (see reducer.ts).

export type HudProvider = 'claude' | 'codex';

export interface HudActivity {
  kind: 'thinking' | 'tool_running' | 'waiting_permission';
  toolName?: string;
  toolArg?: string;
  elapsedMs: number;
}

export interface HudSubagent {
  agentId: string;
  name: string;
  model?: string;
  status: 'running' | 'done_ok' | 'done_err';
  summary?: string;
}

export interface HudTodo {
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface HudQuotaBar {
  label: string;
  pct: number;
  resetsIn?: string;
}

export interface HudState {
  sessionShortId: string;
  workspaceName: string;
  gitBranch?: string;
  provider: HudProvider;
  model: string;
  modelMaxContext: number;
  turnNumber: number;

  contextUsedTok: number;
  currentActivity: HudActivity | null;
  toolTally: ReadonlyMap<string, number>;
  pendingTools: ReadonlyMap<string, string>;
  subagents: ReadonlyArray<HudSubagent>;
  todoList: ReadonlyArray<HudTodo>;

  quotaBars: ReadonlyArray<HudQuotaBar>;

  costThisTurn: number;
  costSession: number;
  startedAtMs: number;
  durationMs: number;

  isFrozen: boolean;
  isErrored: boolean;
  errorSummary?: string;

  // v2 additions
  askPending: boolean;
  tokensTotal?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreate: number;
  };
}

export interface InitialHudStateInput {
  sessionShortId: string;
  workspaceName: string;
  gitBranch?: string;
  provider: HudProvider;
  model: string;
  modelMaxContext: number;
  turnNumber: number;
  startedAtMs: number;
  costSession: number;
}

export function initialHudState(input: InitialHudStateInput): HudState {
  return {
    sessionShortId: input.sessionShortId,
    workspaceName: input.workspaceName,
    gitBranch: input.gitBranch,
    provider: input.provider,
    model: input.model,
    modelMaxContext: input.modelMaxContext,
    turnNumber: input.turnNumber,
    contextUsedTok: 0,
    currentActivity: null,
    toolTally: new Map(),
    pendingTools: new Map(),
    subagents: [],
    todoList: [],
    quotaBars: [],
    costThisTurn: 0,
    costSession: input.costSession,
    startedAtMs: input.startedAtMs,
    durationMs: 0,
    isFrozen: false,
    isErrored: false,
    askPending: false,
  };
}

/**
 * Resolve the HUD model label using the v2 fallback chain (spec § 5.3).
 * Eliminates the 'unknown' literal that surfaces in smoke when neither
 * SDK system frame nor workspace defaults yields a model name.
 */
export function resolveModelLabel(
  systemFrameModel: string | null | undefined,
  workspaceDefaultModel: string | null | undefined,
  sessionMetadataModel: string | null | undefined,
): string {
  return (
    (systemFrameModel && systemFrameModel.trim()) ||
    (workspaceDefaultModel && workspaceDefaultModel.trim()) ||
    (sessionMetadataModel && sessionMetadataModel.trim()) ||
    'claude-sonnet-4'
  );
}
