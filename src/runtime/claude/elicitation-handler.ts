// src/runtime/claude/elicitation-handler.ts
//
// Adapts the Claude Agent SDK's `onElicitation` callback to tlive's
// ElicitationRequest shape. SDK field names differ from the plan stub:
// serverName / requestedSchema / message (vs mcp_server_name / schema /
// description) — we translate here.

import { randomBytes } from 'node:crypto';
import type { ElicitationRequest } from '../types.js';
import type {
  ElicitationRequest as SdkElicitationRequest,
  ElicitationResult as SdkElicitationResult,
} from '@anthropic-ai/claude-agent-sdk';

export interface ElicitationContext {
  sdkSessionId: () => string | null;
  emitRequest: (req: ElicitationRequest) => void;
}

export function makeOnElicitation(ctx: ElicitationContext) {
  return (request: SdkElicitationRequest, _options: { signal: AbortSignal }): Promise<SdkElicitationResult> => {
    return new Promise((resolve) => {
      const shortId = randomBytes(4).toString('hex');
      const mode: ElicitationRequest['mode'] = request.mode === 'url' ? 'url-auth'
        : request.requestedSchema ? 'form' : 'confirm';
      const sid = ctx.sdkSessionId() ?? 'pending';
      const req: ElicitationRequest = {
        id: `${sid}:${shortId}`,
        mcpServerName: request.serverName ?? 'unknown',
        mode,
        schema: request.requestedSchema as ElicitationRequest['schema'],
        description: request.message,
        url: mode === 'url-auth' ? request.url : undefined,
        resolve: (result) => resolve(result as SdkElicitationResult),
      };
      ctx.emitRequest(req);
    });
  };
}
