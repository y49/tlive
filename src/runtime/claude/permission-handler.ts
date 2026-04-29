// src/runtime/claude/permission-handler.ts
//
// Adapts the Claude Agent SDK's `canUseTool` callback to tlive's
// PermissionRequest shape. Categorizes each request via the injected
// categorize() and routes the decision back to the SDK. Uses SDK-native
// types (CanUseTool, PermissionResult) so option payloads round-trip
// without loss (suggestions, toolUseID, etc.).

import { randomBytes } from 'node:crypto';
import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import type { PermissionRequest, PermissionDecision } from '../types.js';

export interface ClaudeCanUseToolContext {
  sdkSessionId: () => string | null;
  emitRequest: (req: PermissionRequest) => void;
  categorize: (toolName: string, toolInput: Record<string, unknown>) => {
    category: PermissionRequest['category'];
    diffPreview?: PermissionRequest['diffPreview'];
    risk?: PermissionRequest['risk'];
  };
}

export function makeCanUseTool(ctx: ClaudeCanUseToolContext): CanUseTool {
  return (toolName, toolInput, options) => {
    return new Promise<PermissionResult>((resolve) => {
      const shortId = randomBytes(4).toString('hex');
      const { category, diffPreview, risk } = ctx.categorize(toolName, toolInput);
      const _sid = ctx.sdkSessionId() ?? 'pending';
      void _sid; // sid not embedded in id any more — IM callback path can't parse `:` inside reqId
      const suggestions = options.suggestions;
      const request: PermissionRequest = {
        // 8-hex; globally unique within a session's pending map; safe inside
        // Telegram inline-keyboard callback_data which is `:`-delimited.
        id: shortId,
        category,
        toolName,
        toolInput,
        toolUseId: options.toolUseID,
        diffPreview,
        risk,
        suggestions,
        resolve: (decision: PermissionDecision) => {
          if (decision === 'allow') {
            resolve({ behavior: 'allow', updatedInput: toolInput });
          } else if (decision === 'allow_always') {
            const reply: PermissionResult = {
              behavior: 'allow',
              updatedInput: toolInput,
              updatedPermissions: suggestions as PermissionUpdate[] | undefined,
            };
            resolve(reply);
          } else {
            resolve({ behavior: 'deny', message: 'Denied by user' });
          }
        },
      };
      ctx.emitRequest(request);
    });
  };
}
