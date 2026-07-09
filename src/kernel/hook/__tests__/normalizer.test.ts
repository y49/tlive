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
    expect(n).toEqual({ event: 'attention', cwd: '/r', sessionId: 's', message: '已完成,回复以续跑' });
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
  it('parses Stop with last_assistant_message into attention.lastMessage', () => {
    const n = parseHookInput('stop', { cwd: '/r', session_id: 's', last_assistant_message: 'all done' });
    expect(n).toEqual({ event: 'attention', cwd: '/r', sessionId: 's', message: '已完成,回复以续跑', lastMessage: 'all done' });
  });
  it('parses UserPromptSubmit as prompt', () => {
    const n = parseHookInput('user-prompt-submit', { cwd: '/r', session_id: 's', prompt: 'fix the bug' });
    expect(n).toEqual({ event: 'prompt', cwd: '/r', sessionId: 's', prompt: 'fix the bug' });
  });
  it('parses SessionStart with source', () => {
    const n = parseHookInput('session-start', { cwd: '/r', session_id: 's', source: 'startup' });
    expect(n).toEqual({ event: 'session-start', cwd: '/r', sessionId: 's', source: 'startup' });
  });
  it('parses SessionEnd with reason', () => {
    const n = parseHookInput('session-end', { cwd: '/r', session_id: 's', reason: 'clear' });
    expect(n).toEqual({ event: 'session-end', cwd: '/r', sessionId: 's', reason: 'clear' });
  });
});

describe('permissionDecisionOut vendor', () => {
  it('claude allow/deny/defer 保持原样(向后兼容)', () => {
    expect(permissionDecisionOut('allow')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
    expect(permissionDecisionOut('deny')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
    expect(permissionDecisionOut('defer')).toEqual({});
  });
  it('codex deny 必带非空 permissionDecisionReason', () => {
    const out = permissionDecisionOut('deny', 'codex') as any;
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(typeof out.hookSpecificOutput.permissionDecisionReason).toBe('string');
    expect(out.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0);
  });
  it('codex deny 用传入 reason', () => {
    const out = permissionDecisionOut('deny', 'codex', '用户拒绝') as any;
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe('用户拒绝');
  });
  it('codex defer → ask(绝不 auto-allow)', () => {
    expect(permissionDecisionOut('defer', 'codex')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } });
  });
  it('codex allow 与 claude 同', () => {
    expect(permissionDecisionOut('allow', 'codex')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
  });
  it('未预期 decision 值 → 视作 defer(clamp;绝不 auto-allow)', () => {
    // @ts-expect-error 故意传非法值,验证运行时兜底
    expect(permissionDecisionOut('bogus', 'codex')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } });
    // @ts-expect-error
    expect(permissionDecisionOut('bogus', 'claude')).toEqual({});
  });
});
