import { describe, it, expect } from 'vitest';
import { parseHookInput, permissionDecisionOut, continueDecisionOut } from '../normalizer.js';

describe('hook normalizer', () => {
  it('parses PreToolUse', () => {
    const n = parseHookInput('pre-tool-use', { cwd: '/repo', session_id: 's1', tool_name: 'Edit', tool_input: { file: 'a' } });
    expect(n).toEqual({ event: 'approval-request', cwd: '/repo', sessionId: 's1', toolName: 'Edit', input: { file: 'a' } });
  });
  it('parses PostToolUse as activity', () => {
    const n = parseHookInput('post-tool-use', { cwd: '/r', session_id: 's', tool_name: 'Bash', tool_response: { ok: true } });
    expect(n).toEqual({ event: 'activity', cwd: '/r', sessionId: 's', toolName: 'Bash', result: { ok: true } });
  });
  it('parses Stop as attention', () => {
    const n = parseHookInput('stop', { cwd: '/r', session_id: 's' });
    expect(n).toEqual({ event: 'attention', cwd: '/r', sessionId: 's', message: 'Claude 已完成,回复以续跑' });
  });
  it('parses Notification with message', () => {
    const n = parseHookInput('notification', { cwd: '/r', session_id: 's', message: '需要权限' });
    expect(n).toEqual({ event: 'attention', cwd: '/r', sessionId: 's', message: '需要权限' });
  });
  it('allow → permissionDecision allow', () => {
    expect(permissionDecisionOut('allow')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
  });
  it('deny → permissionDecision deny', () => {
    expect(permissionDecisionOut('deny')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
  });
  it('defer → empty object (fall through to local TUI)', () => {
    expect(permissionDecisionOut('defer')).toEqual({});
  });
  it('continue reply → block+reason; null → empty', () => {
    expect(continueDecisionOut('run tests')).toEqual({ decision: 'block', reason: 'run tests' });
    expect(continueDecisionOut(null)).toEqual({});
  });
});
