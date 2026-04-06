import { getBridgeContext } from '../context.js';
import type { CanonicalEvent } from '../messages/schema.js';
import type { LLMProvider, FileAttachment, PermissionRequestHandler, QueryControls, StreamChatResult } from '../providers/base.js';
import type { AskUserQuestionHandler } from '../messages/types.js';

const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/javascript', 'application/typescript', 'application/x-yaml', 'application/toml'];

function isTextMime(mime: string): boolean {
  return TEXT_MIME_PREFIXES.some(p => mime.startsWith(p));
}

function buildPromptWithAttachments(text: string, attachments?: FileAttachment[]): string {
  if (!attachments?.length) return text;

  const parts: string[] = [];
  if (text) parts.push(text);

  for (const att of attachments) {
    if (att.type === 'file' && isTextMime(att.mimeType)) {
      const decoded = Buffer.from(att.base64Data, 'base64').toString('utf-8');
      parts.push(`\n[File: ${att.name}]\n\`\`\`\n${decoded}\n\`\`\``);
    } else if (att.type === 'file') {
      parts.push(`\n[Attached file: ${att.name} (${att.mimeType}) — binary file, cannot display inline]`);
    }
    // Images are passed via the attachments array to the LLM provider directly
  }

  return parts.join('\n');
}

interface ProcessMessageParams {
  sessionId: string;
  text: string;
  attachments?: FileAttachment[];
  onTextDelta?: (delta: string) => void;
  onToolStart?: (event: { id: string; name: string; input: Record<string, unknown> }) => void;
  onToolResult?: (event: { toolUseId: string; content: string; isError: boolean }) => void;
  onQueryResult?: (event: { sessionId: string; isError: boolean; usage: { inputTokens: number; outputTokens: number; costUsd?: number; modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }> }; permissionDenials?: Array<{ toolName: string; toolUseId: string }> }) => void;
  onError?: (error: string) => void;
  onAgentStart?: (data: { description: string; taskId?: string }) => void;
  onAgentProgress?: (data: { description: string; lastTool?: string; usage?: { toolUses: number; durationMs: number } }) => void;
  onAgentComplete?: (data: { summary: string; status: string }) => void;
  onPromptSuggestion?: (suggestion: string) => void;
  onToolProgress?: (data: { toolName: string; elapsed: number }) => void;
  onTodoUpdate?: (todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>) => void;
  onRateLimit?: (data: { status: string; utilization?: number; resetsAt?: number }) => void;
  /** Receives query controls (interrupt, stopTask) when available */
  onControls?: (controls: QueryControls) => void;
  /** SDK-level permission handler — forwarded to streamChat */
  sdkPermissionHandler?: PermissionRequestHandler;
  /** SDK-level AskUserQuestion handler — forwarded to streamChat */
  sdkAskQuestionHandler?: AskUserQuestionHandler;
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Override model for this query */
  model?: string;
  /** Override LLM provider (for per-chat runtime selection) */
  llm?: LLMProvider;
  /** Pre-built stream from LiveSession.startTurn() — skips llm.streamChat() */
  streamResult?: StreamChatResult;
}

interface ProcessMessageResult {
  text: string;
  sessionId: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
}

export class ConversationEngine {
  async processMessage(params: ProcessMessageParams): Promise<ProcessMessageResult> {
    const { store, llm: defaultLlm, defaultWorkdir } = getBridgeContext();
    const llm = params.llm || defaultLlm;
    const lockKey = `session:${params.sessionId}`;
    let fullText = '';
    let usage: { inputTokens: number; outputTokens: number; costUsd?: number } | undefined;

    // 1. Acquire lock
    await store.acquireLock(lockKey, 600_000);

    try {
      // 2. Build prompt with file content injected
      const imageAttachments = params.attachments?.filter(a => a.type === 'image');
      const prompt = buildPromptWithAttachments(params.text, params.attachments);

      // 3. Save user message
      await store.saveMessage(params.sessionId, {
        role: 'user',
        content: prompt,
        timestamp: new Date().toISOString(),
      });

      // 4. Get session info — use config's defaultWorkdir instead of process.cwd()
      //    (bridge daemon CWD may differ from user's project directory)
      const session = await store.getSession(params.sessionId);
      const workDir = session?.workingDirectory ?? defaultWorkdir;

      // 5. Stream LLM response — use pre-built stream from LiveSession or call streamChat
      const result = params.streamResult ?? llm.streamChat({
        prompt,
        workingDirectory: workDir,
        model: params.model,
        sessionId: session?.sdkSessionId,
        attachments: imageAttachments?.length ? imageAttachments : undefined,
        onPermissionRequest: params.sdkPermissionHandler,
        onAskUserQuestion: params.sdkAskQuestionHandler,
        effort: params.effort,
      });

      // Expose query controls (interrupt, stopTask) to caller
      if (result.controls) {
        params.onControls?.(result.controls);
      }

      // 6. Consume stream — reader now gives CanonicalEvent objects directly
      const reader = result.stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        switch (value.kind) {
          case 'text_delta':
            fullText += value.text;
            params.onTextDelta?.(value.text);
            break;
          case 'thinking_delta':
            // Not accumulated — thinking is internal
            break;
          case 'tool_start':
            params.onToolStart?.(value);
            break;
          case 'tool_result':
            params.onToolResult?.(value);
            break;
          case 'query_result': {
            usage = value.usage;
            if (value.sessionId) {
              const existing = await store.getSession(params.sessionId);
              await store.saveSession({
                id: params.sessionId,
                workingDirectory: existing?.workingDirectory ?? defaultWorkdir,
                createdAt: existing?.createdAt ?? new Date().toISOString(),
                sdkSessionId: value.sessionId,
              });
            }
            params.onQueryResult?.(value);
            break;
          }
          case 'agent_start':
            params.onAgentStart?.(value);
            break;
          case 'agent_progress':
            params.onAgentProgress?.(value);
            break;
          case 'agent_complete':
            params.onAgentComplete?.(value);
            break;
          case 'prompt_suggestion':
            params.onPromptSuggestion?.(value.suggestion);
            break;
          case 'tool_progress':
            params.onToolProgress?.(value);
            break;
          case 'todo_update':
            params.onTodoUpdate?.(value.todos);
            break;
          case 'rate_limit':
            params.onRateLimit?.(value);
            break;
          case 'error':
            params.onError?.(value.message);
            break;
        }
      }

      // 7. Save assistant message
      await store.saveMessage(params.sessionId, {
        role: 'assistant',
        content: fullText,
        timestamp: new Date().toISOString(),
      });

    } finally {
      // 8. Release lock
      await store.releaseLock(lockKey);
    }

    return { text: fullText, sessionId: params.sessionId, usage };
  }
}
