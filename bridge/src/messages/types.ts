import type { CanonicalEvent } from './schema.js';

/** File attachment for LLM vision/file input */
export interface FileAttachment {
  type: 'image' | 'file';
  name: string;
  mimeType: string;
  base64Data: string;
}

/** Permission request handler — called by canUseTool */
export type PermissionRequestHandler = (
  toolName: string,
  toolInput: Record<string, unknown>,
  promptSentence: string,
  signal?: AbortSignal,
) => Promise<'allow' | 'allow_always' | 'deny'>;

/** AskUserQuestion handler — returns user's answers */
export type AskUserQuestionHandler = (
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description?: string; preview?: string }>;
    multiSelect: boolean;
  }>,
  signal?: AbortSignal,
) => Promise<Record<string, string>>;

/** Controls for an active query */
export interface QueryControls {
  interrupt(): Promise<void>;
  stopTask(taskId: string): Promise<void>;
}

/** Session configuration — consolidates scattered per-chat Maps (used in sub-project 2) */
export interface SessionMode {
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

/** Provider-agnostic interface (implemented in sub-project 2) */
export interface ProviderBackend {
  startQuery(params: {
    prompt: string;
    workingDirectory: string;
    sessionId?: string;
    mode: SessionMode;
    attachments?: FileAttachment[];
    onPermissionRequest?: PermissionRequestHandler;
    onAskUserQuestion?: AskUserQuestionHandler;
  }): {
    stream: ReadableStream<CanonicalEvent>;
    controls?: QueryControls;
  };

  dispose(): Promise<void>;
}
