import type { CanonicalEvent } from '../messages/schema.js';

/** Called by canUseTool when permission prompting is enabled. */
export type PermissionRequestHandler = (
  toolName: string,
  toolInput: Record<string, unknown>,
  promptSentence: string,
  signal?: AbortSignal,
) => Promise<'allow' | 'allow_always' | 'deny'>;

/** AskUserQuestion handler type */
export type AskUserQuestionHandler = (
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description?: string; preview?: string }>;
    multiSelect: boolean;
  }>,
  signal?: AbortSignal,
) => Promise<Record<string, string>>;

export interface StreamChatParams {
  prompt: string;
  workingDirectory: string;
  model?: string;
  sessionId?: string;
  permissionMode?: 'acceptEdits' | 'plan' | 'default';
  attachments?: FileAttachment[];
  abortSignal?: AbortSignal;
  /** When set, canUseTool forwards permission requests through this handler instead of auto-allowing */
  onPermissionRequest?: PermissionRequestHandler;
  /** Handler for AskUserQuestion tool — returns user's answer */
  onAskUserQuestion?: AskUserQuestionHandler;
  /** Controls Claude's thinking depth: low/medium/high/max */
  effort?: 'low' | 'medium' | 'high' | 'max';
}

export interface FileAttachment {
  type: 'image' | 'file';
  name: string;
  mimeType: string;
  base64Data: string;
}

/** Controls for an active query — interrupt, stop subagents, etc. */
export interface QueryControls {
  interrupt(): Promise<void>;
  stopTask(taskId: string): Promise<void>;
}

export interface StreamChatResult {
  stream: ReadableStream<CanonicalEvent>;
  controls?: QueryControls;
}

/** Parameters for starting a turn within a LiveSession */
export interface TurnParams {
  attachments?: FileAttachment[];
  /** Permission handler for this turn */
  onPermissionRequest?: PermissionRequestHandler;
  /** AskUserQuestion handler for this turn */
  onAskUserQuestion?: AskUserQuestionHandler;
  effort?: 'low' | 'medium' | 'high' | 'max';
  model?: string;
}

/**
 * Long-lived session wrapping a persistent query/thread.
 * Aligned with both Claude SDK's AsyncGenerator model and Codex's Thread/Turn/Steer model.
 */
export interface LiveSession {
  /** Start a new turn (user message → agent response). Returns per-turn event stream. */
  startTurn(prompt: string, params?: TurnParams): StreamChatResult;
  /** Inject into active turn — like Codex turn/steer. No-op if no turn is active. */
  steerTurn(text: string): void;
  /** Interrupt the active turn */
  interruptTurn(): Promise<void>;
  /** Close session and release all resources */
  close(): void;
  /** Whether the underlying query/thread is still alive */
  readonly isAlive: boolean;
  /** Whether a turn is currently in progress */
  readonly isTurnActive: boolean;
}

/** Declares which SDK features a provider supports. */
export interface ProviderCapabilities {
  /** Can handle /compact, /clear etc. as prompt */
  slashCommands: boolean;
  /** Supports AskUserQuestion tool via canUseTool */
  askUserQuestion: boolean;
  /** Supports long-lived sessions via createSession() */
  liveSession: boolean;
  /** Emits TodoWrite tool_use events */
  todoTracking: boolean;
  /** Reports cost_usd in query results */
  costInUsd: boolean;
  /** Supports settingSources, skills, MCP servers */
  skills: boolean;
  /** Supports session resume via session ID */
  sessionResume: boolean;
}

export interface LLMProvider {
  streamChat(params: StreamChatParams): StreamChatResult;
  capabilities(): ProviderCapabilities;
  /** Create a long-lived session. Returns undefined if not supported. */
  createSession?(params: { workingDirectory: string; sessionId?: string; effort?: 'low' | 'medium' | 'high' | 'max'; model?: string }): LiveSession;
}
