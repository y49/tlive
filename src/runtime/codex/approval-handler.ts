// src/runtime/codex/approval-handler.ts
//
// Splits codex-app-server's three server-request approval types
//   - item/commandExecution/requestApproval
//   - item/fileChange/requestApproval
//   - item/permissions/requestApproval
// into categorized PermissionRequest events and routes the decision back
// to the codex app-server. Risk heuristics mirror categorizeClaudeToolUse.

import { randomBytes } from 'node:crypto';
import type { PermissionRequest, PermissionDecision } from '../types.js';

export type CodexApprovalResult =
  | { outcome: 'approved_for_request' }
  | { outcome: 'approved_for_session' }
  | { outcome: 'denied' };

export interface CodexApprovalContext {
  sdkSessionId: () => string | null;
  emitRequest: (req: PermissionRequest) => void;
}

/** item/commandExecution/requestApproval */
export function makeExecApprovalHandler(ctx: CodexApprovalContext) {
  return (params: { command: string; cwd?: string; call_id?: string }): Promise<CodexApprovalResult> =>
    new Promise((resolve) => {
      const req = buildRequest(ctx, {
        category: 'exec',
        toolName: 'bash',
        toolInput: { command: params.command, cwd: params.cwd },
        toolUseId: params.call_id,
        risk: riskOfExec(params.command),
      }, resolve);
      ctx.emitRequest(req);
    });
}

/** item/fileChange/requestApproval */
export function makeFileChangeApprovalHandler(ctx: CodexApprovalContext) {
  return (params: { path: string; diff?: string; call_id?: string }): Promise<CodexApprovalResult> =>
    new Promise((resolve) => {
      const { from, to, added, removed } = parseDiff(params.diff ?? '');
      const req = buildRequest(ctx, {
        category: 'file-edit',
        toolName: 'apply_patch',
        toolInput: { path: params.path, diff: params.diff },
        toolUseId: params.call_id,
        diffPreview: { from, to, added, removed, path: params.path },
        risk: 'medium',
      }, resolve);
      ctx.emitRequest(req);
    });
}

/** item/permissions/requestApproval */
export function makePermissionsApprovalHandler(ctx: CodexApprovalContext) {
  return (params: { description?: string; call_id?: string; [k: string]: unknown }): Promise<CodexApprovalResult> =>
    new Promise((resolve) => {
      const req = buildRequest(ctx, {
        category: 'generic',
        toolName: params.description ?? 'permission',
        toolInput: params,
        toolUseId: params.call_id,
        risk: 'low',
      }, resolve);
      ctx.emitRequest(req);
    });
}

function buildRequest(
  ctx: CodexApprovalContext,
  data: Omit<PermissionRequest, 'id' | 'resolve'>,
  resolveOuter: (r: CodexApprovalResult) => void,
): PermissionRequest {
  const shortId = randomBytes(4).toString('hex');
  // sid intentionally not embedded — `:` inside reqId would break IM callback_data parsing.
  return {
    id: shortId,
    ...data,
    resolve: (decision: PermissionDecision) => {
      if (decision === 'allow') resolveOuter({ outcome: 'approved_for_request' });
      else if (decision === 'allow_always') resolveOuter({ outcome: 'approved_for_session' });
      else resolveOuter({ outcome: 'denied' });
    },
  };
}

function riskOfExec(command: string): PermissionRequest['risk'] {
  if (/\b(rm\s+-rf|sudo|curl.*\|\s*sh|chmod\s+777)\b/.test(command)) return 'high';
  if (/\b(rm|mv|chmod|chown|kill)\b/.test(command)) return 'medium';
  return 'low';
}

function parseDiff(diff: string): { from: string; to: string; added: number; removed: number } {
  const lines = diff.split('\n');
  let added = 0;
  let removed = 0;
  const fromLines: string[] = [];
  const toLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) { added++; toLines.push(line.slice(1)); }
    else if (line.startsWith('-') && !line.startsWith('---')) { removed++; fromLines.push(line.slice(1)); }
  }
  return { from: fromLines.join('\n'), to: toLines.join('\n'), added, removed };
}
