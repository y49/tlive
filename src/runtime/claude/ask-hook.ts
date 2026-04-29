// src/runtime/claude/ask-hook.ts
//
// PreToolUse hook for Claude SDK's builtin AskUserQuestion. SDK fires the
// hook before the builtin handler runs (which would expect a transport-level
// PromptRequest exchange — unavailable in daemon mode). We hijack:
//  1. Parse the SDK AskUserQuestionInput (questions[1..4], each with options[2..4]).
//  2. Forward as tlive AskUserQuestionRequest → askBroker → IM ask card.
//  3. Block on the resolve Promise.
//  4. Return `permissionDecision: 'deny' + permissionDecisionReason: <answer text>`,
//     which makes SDK skip the builtin handler and relay the reason text into the
//     conversation — Claude reads it as the user's answer and continues.
//
// We only handle the FIRST question for the IM card; multi-question batches (rare)
// are flattened: ask only questions[0], and the answer is repeated for any remaining
// keys to keep the SDK output schema honest.

import { randomBytes } from 'node:crypto';
import type {
  HookCallback,
  PreToolUseHookInput,
  HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import type { AskUserQuestionRequest, AskUserQuestionOption } from '../types.js';

interface SdkAskUserQuestionInput {
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string; preview?: string }>;
    multiSelect?: boolean;
  }>;
}

export interface AskHookContext {
  sdkSessionId: () => string | null;
  /** Forwards the request to the runtime's askBroker pipeline. */
  emitRequest: (req: AskUserQuestionRequest) => void;
}

export function makeAskUserQuestionHook(ctx: AskHookContext): HookCallback {
  return async (input, _toolUseID, _options): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const pretool = input as PreToolUseHookInput;
    if (pretool.tool_name !== 'AskUserQuestion') return { continue: true };

    const aiq = pretool.tool_input as SdkAskUserQuestionInput;
    const first = aiq?.questions?.[0];
    if (!first || !Array.isArray(first.options) || first.options.length < 2) {
      // Malformed — let SDK proceed and likely error.
      return { continue: true };
    }

    const options: AskUserQuestionOption[] = first.options.map((o) => ({
      label: o.label,
      description: o.description,
      preview: o.preview,
    }));

    // 8-hex shortId only — no sid prefix, because IM callback_data parses
    // `ask:<reqId>:<verb>` and embedding `:` inside reqId breaks the regex.
    const id = randomBytes(4).toString('hex');
    const chosen = await new Promise<string[]>((resolve) => {
      const req: AskUserQuestionRequest = {
        id,
        prompt: first.question,
        header: first.header,
        options,
        multiSelect: first.multiSelect ?? false,
        // SDK builtin always offers an "Other" fallback; surface custom-input UI.
        allowCustom: true,
        resolve: (value) => resolve(value),
      };
      ctx.emitRequest(req);
    });

    // Build a JSON-shaped answer for SDK (matches AskUserQuestionOutput.answers map):
    // { [questionText]: chosen.join(', ') } — concise; supports multi-select.
    const answerText = chosen.length > 0 ? chosen.join(', ') : '(no answer provided)';
    const answerJson = JSON.stringify({
      questions: aiq.questions.map((q) => ({
        question: q.question, header: q.header, options: q.options,
        multiSelect: q.multiSelect ?? false,
      })),
      answers: aiq.questions.reduce<Record<string, string>>((acc, q) => {
        acc[q.question] = answerText; // first question gets the real answer; others repeat (rare batch path)
        return acc;
      }, {}),
    });

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `User answered AskUserQuestion via IM card.\n` +
          `Selected: ${answerText}\n` +
          `(Synthetic AskUserQuestionOutput JSON: ${answerJson})`,
      },
    };
  };
}
