import type { CanonicalEvent } from '../messages/schema.js';

/** Called by canUseTool when permission prompting is enabled. */
export type PermissionRequestHandler = (
  toolName: string,
  toolInput: Record<string, unknown>,
  promptSentence: string,
  signal?: AbortSignal,
) => Promise<'allow' | 'allow_always' | 'deny'>;

/** Queue for injecting user messages into an active streaming query. */
export class MessageInjector {
  private queue: string[] = [];
  private waiter: ((msg: string | null) => void) | null = null;
  private closed = false;

  /** Inject a message into the active query. */
  push(text: string): void {
    if (this.closed) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(text);
    } else {
      this.queue.push(text);
    }
  }

  /** Wait for the next injected message. Returns null when closed. */
  next(): Promise<string | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise(resolve => { this.waiter = resolve; });
  }

  /** Close the injector — signals the generator to stop. */
  close(): void {
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(null);
    }
  }
}

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
  /** When provided, enables streaming input — messages can be injected mid-query */
  messageInjector?: MessageInjector;
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
