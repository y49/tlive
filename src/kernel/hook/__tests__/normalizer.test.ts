import { describe, it, expect } from 'vitest';
import { parseHookInput, permissionRequestDecisionOut, continueDecisionOut, sessionStartOut } from '../normalizer.js';

describe('hook normalizer', () => {
  it('parses PostToolUse as activity', () => {
    const n = parseHookInput('post-tool-use', { cwd: '/r', session_id: 's', tool_name: 'Bash', tool_response: { ok: true } });
    expect(n).toEqual({ event: 'activity', cwd: '/r', sessionId: 's', toolName: 'Bash', result: { ok: true } });
  });
  it('parses Stop as attention', () => {
    const n = parseHookInput('stop', { cwd: '/r', session_id: 's' });
    expect(n).toEqual({ event: 'attention', cwd: '/r', sessionId: 's', message: 'Turn finished — reply to continue' });
  });
  it('parses Notification with message', () => {
    const n = parseHookInput('notification', { cwd: '/r', session_id: 's', message: '需要权限' });
    expect(n).toEqual({ event: 'attention', cwd: '/r', sessionId: 's', message: '需要权限' });
  });
  it('continue reply → block+reason; null → empty', () => {
    expect(continueDecisionOut('run tests')).toEqual({ decision: 'block', reason: 'run tests' });
    expect(continueDecisionOut(null)).toEqual({});
  });
  it('parses Stop with last_assistant_message into attention.lastMessage', () => {
    const n = parseHookInput('stop', { cwd: '/r', session_id: 's', last_assistant_message: 'all done' });
    expect(n).toEqual({ event: 'attention', cwd: '/r', sessionId: 's', message: 'Turn finished — reply to continue', lastMessage: 'all done' });
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

describe('notification notification_type', () => {
  it('idle_prompt / 无 type → 原样 message(现行为不变)', () => {
    const a = parseHookInput('notification', { cwd: '/x', session_id: 's', notification_type: 'idle_prompt', message: 'waiting' });
    expect((a as any).message).toBe('waiting');
    const b = parseHookInput('notification', { cwd: '/x', session_id: 's', message: 'hi' });
    expect((b as any).message).toBe('hi');
  });
});

describe('permission-request / permission-denied (CC dual-channel)', () => {
  it('normalizes permission-request to approval-request', () => {
    const n = parseHookInput('permission-request', {
      cwd: '/w', session_id: 's1', tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' }, permission_mode: 'default',
    });
    expect(n).toEqual({
      event: 'approval-request', cwd: '/w', sessionId: 's1',
      toolName: 'Bash', input: { command: 'rm -rf /' }, permissionMode: 'default',
    });
  });
  it('normalizes permission-denied to a monitor event carrying toolName', () => {
    const n = parseHookInput('permission-denied', { cwd: '/w', session_id: 's1', tool_name: 'Bash' });
    expect(n).toEqual({ event: 'permission-denied', cwd: '/w', sessionId: 's1', toolName: 'Bash' });
  });
  it('permissionRequestDecisionOut wire shapes (never auto-allow/deny on defer)', () => {
    expect(permissionRequestDecisionOut('allow')).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    // deny 恒带 message:Codex 缺省会自动补理由(源码验证不 fail-open),
    // 但显式给一条对两家都更友好;CC 2.1.206 真机验证接受 message 字段。
    expect(permissionRequestDecisionOut('deny')).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied via tlive' } },
    });
    expect(permissionRequestDecisionOut('deny', 'user rejected')).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'user rejected' } },
    });
    expect(permissionRequestDecisionOut('defer')).toEqual({});
  });
  it('same wire serves both vendors — no vendor branch in the function signature', () => {
    // Codex 0.144 schema.rs PermissionRequestDecisionWire 与 CC 同形;
    // 该测试锁死"不发 updatedInput/updatedPermissions/interrupt"(Codex fail-closed 字段)。
    const out = permissionRequestDecisionOut('allow') as { hookSpecificOutput: { decision: Record<string, unknown> } };
    expect(Object.keys(out.hookSpecificOutput.decision)).toEqual(['behavior']);
  });
});

describe('failure events', () => {
  it('post-tool-use-failure → attention ❌ 工具名+错误截断', () => {
    const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash', tool_error: 'E'.repeat(500) });
    expect(n.event).toBe('attention');
    expect((n as any).message).toContain('❌');
    expect((n as any).message).toContain('Bash');
    expect((n as any).message.length).toBeLessThan(300);
  });
  it('stop-failure → attention ❌ error_type', () => {
    const n = parseHookInput('stop-failure', { cwd: '/x', session_id: 's', error_type: 'rate_limit' });
    expect((n as any).message).toContain('❌');
    expect((n as any).message).toContain('rate_limit');
  });
});

describe('sessionStartOut(欢迎提示)', () => {
  it('claude + IM 未配置 → additionalContext', () => {
    const o = JSON.parse(sessionStartOut('claude', false));
    expect(o.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(o.hookSpecificOutput.additionalContext).toContain('帮我配置 tlive');
  });
  it('claude + 已配置 → {}', () => expect(sessionStartOut('claude', true)).toBe('{}'));
  it('codex → 恒 {}(输出 schema deny_unknown_fields)', () => {
    expect(sessionStartOut('codex', false)).toBe('{}');
    expect(sessionStartOut('codex', true)).toBe('{}');
  });
});

describe('subagent 监看事件', () => {
  it('subagent-start → delta 1 + agentType', () => {
    const n = parseHookInput('subagent-start', { cwd: '/x', session_id: 's', agent_type: 'Explore' });
    expect(n).toEqual({ event: 'subagent', cwd: '/x', sessionId: 's', delta: 1, agentType: 'Explore' });
  });
  it('subagent-stop → delta -1', () => {
    const n = parseHookInput('subagent-stop', { cwd: '/x', session_id: 's', agent_type: 'general-purpose' });
    expect(n).toMatchObject({ event: 'subagent', delta: -1, agentType: 'general-purpose' });
  });
  it('无 agent_type → 不带 agentType 字段', () => {
    const n = parseHookInput('subagent-start', { cwd: '/x', session_id: 's' }) as any;
    expect(n.agentType).toBeUndefined();
    expect(n.delta).toBe(1);
  });
});
