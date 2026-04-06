import type { CanonicalEvent } from '../messages/schema.js';

/** Called by canUseTool when permission prompting is enabled. */
export type PermissionRequestHandler = (
  toolName: string,
  toolInput: Record<string, unknown>,
  promptSentence: string,
  signal?: AbortSignal,
) => Promise<'allow' | 'allow_always' | 'deny'>;

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
  onAskUserQuestion?: (
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect: boolean;
    }>,
    signal?: AbortSignal,
  ) => Promise<Record<string, string>>;
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

/** Declares which SDK features a provider supports. */
export interface ProviderCapabilities {
  /** Can handle /compact, /clear etc. as prompt */
  slashCommands: boolean;
  /** Supports AskUserQuestion tool via canUseTool */
  askUserQuestion: boolean;
  /** Supports AsyncGenerator prompt for mid-query message injection */
  streamingInput: boolean;
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
}
