/**
 * Codex permission mode presets.
 *
 * Rather than exposing approvalPolicy + sandbox as two independent knobs,
 * this bundles common combinations into 4 named modes:
 *
 *   default    → asks when model needs escalation (safe + interactive)
 *   read-only  → no writes at all (browsing / planning)
 *   safe-yolo  → auto-allow unless sandbox refuses (low interruption)
 *   yolo       → full access, no prompts (fast + risky)
 *
 * Inspired by hapi's resolveCodexPermissionModeConfig pattern.
 */

import type { ApprovalPolicy, SandboxMode } from './workspace-manager.js';

export type CodexPermissionMode = 'default' | 'read-only' | 'safe-yolo' | 'yolo';

export const CODEX_PERMISSION_MODES: readonly CodexPermissionMode[] = [
  'default',
  'read-only',
  'safe-yolo',
  'yolo',
];

export interface CodexPermissionModeConfig {
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
}

export function resolveCodexPermissionMode(mode: CodexPermissionMode): CodexPermissionModeConfig {
  switch (mode) {
    case 'default':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    case 'read-only':
      return { approvalPolicy: 'never', sandbox: 'read-only' };
    case 'safe-yolo':
      return { approvalPolicy: 'on-failure', sandbox: 'workspace-write' };
    case 'yolo':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  }
}

export function isCodexPermissionMode(value: string): value is CodexPermissionMode {
  return (CODEX_PERMISSION_MODES as readonly string[]).includes(value);
}

export function describeCodexPermissionMode(mode: CodexPermissionMode): string {
  const { approvalPolicy, sandbox } = resolveCodexPermissionMode(mode);
  const hints: Record<CodexPermissionMode, string> = {
    'default': 'asks for approval on escalation',
    'read-only': 'no writes; browse/plan only',
    'safe-yolo': 'auto-allow unless sandbox blocks',
    'yolo': 'full access, no prompts (dangerous)',
  };
  return `${mode} — ${hints[mode]} (approval=${approvalPolicy}, sandbox=${sandbox})`;
}
