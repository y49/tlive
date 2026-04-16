import { describe, it, expect } from 'vitest';
import {
  resolveCodexPermissionMode,
  isCodexPermissionMode,
  describeCodexPermissionMode,
  CODEX_PERMISSION_MODES,
} from '../engine/codex-permission-mode.js';

describe('codex permission mode', () => {
  describe('resolveCodexPermissionMode', () => {
    it('default → on-request + workspace-write', () => {
      expect(resolveCodexPermissionMode('default')).toEqual({
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      });
    });

    it('read-only → never + read-only', () => {
      expect(resolveCodexPermissionMode('read-only')).toEqual({
        approvalPolicy: 'never',
        sandbox: 'read-only',
      });
    });

    it('safe-yolo → on-failure + workspace-write', () => {
      expect(resolveCodexPermissionMode('safe-yolo')).toEqual({
        approvalPolicy: 'on-failure',
        sandbox: 'workspace-write',
      });
    });

    it('yolo → never + danger-full-access', () => {
      expect(resolveCodexPermissionMode('yolo')).toEqual({
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      });
    });
  });

  describe('isCodexPermissionMode', () => {
    it('accepts all 4 modes', () => {
      for (const m of CODEX_PERMISSION_MODES) {
        expect(isCodexPermissionMode(m)).toBe(true);
      }
    });

    it('rejects unknown values', () => {
      expect(isCodexPermissionMode('unsafe')).toBe(false);
      expect(isCodexPermissionMode('')).toBe(false);
      expect(isCodexPermissionMode('DEFAULT')).toBe(false);
    });
  });

  describe('describeCodexPermissionMode', () => {
    it('includes the mode name and derived values', () => {
      const desc = describeCodexPermissionMode('default');
      expect(desc).toContain('default');
      expect(desc).toContain('on-request');
      expect(desc).toContain('workspace-write');
    });
  });
});
