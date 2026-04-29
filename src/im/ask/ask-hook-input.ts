// src/im/ask/ask-hook-input.ts
//
// Pure helper: SDK AskUserQuestionInput → tlive AskUserQuestionRequest.
// Lifted from ask-hook.ts so it's unit-testable without SDK type plumbing.

import type { AskUserQuestionRequest, AskUserQuestionOption } from '../../runtime/types.js';

export interface SdkAskUserQuestionInput {
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string; preview?: string }>;
    multiSelect?: boolean;
    /** SDK now exposes whether the builtin "Other" fallback should appear. */
    allowCustom?: boolean;
  }>;
}

export type AskMode = 'single' | 'multi' | 'custom-input';

export function decideAskMode(multiSelect: boolean, allowCustom: boolean): AskMode {
  if (multiSelect) return 'multi';
  if (allowCustom) return 'custom-input';
  return 'single';
}

export function buildAskRequest(
  sdk: SdkAskUserQuestionInput,
  id: string,
  resolve: (chosen: string[]) => void,
): AskUserQuestionRequest {
  const first = sdk.questions[0];
  if (!first) throw new Error('buildAskRequest: empty questions array');
  const options: AskUserQuestionOption[] = first.options.map((o) => ({
    label: o.label,
    description: o.description,
    preview: o.preview,
  }));
  return {
    id,
    prompt: first.question,
    header: first.header,
    options,
    multiSelect: first.multiSelect ?? false,
    allowCustom: first.allowCustom ?? false,
    resolve,
  };
}
