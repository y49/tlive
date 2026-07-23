import { describe, it, expect } from 'vitest';
import { parseHookInput, permissionRequestDecisionOut, sessionStartOut, effectiveMode } from '../normalizer.js';

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
  it('parses Stop with stop_hook_active (loop guard for async rewake)', () => {
    const n = parseHookInput('stop', { cwd: '/r', session_id: 's', stop_hook_active: true });
    expect(n).toMatchObject({ event: 'attention', stopHookActive: true });
    const n2 = parseHookInput('stop', { cwd: '/r', session_id: 's' });
    expect((n2 as { stopHookActive?: boolean }).stopHookActive).toBeUndefined();
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
  it('post-tool-use-failure → attention message with tool name + truncated error, no emoji prefix', () => {
    const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash', tool_error: 'E'.repeat(500) });
    expect(n.event).toBe('attention');
    expect((n as any).message).toContain('Bash');
    expect((n as any).message).toContain('failed');
    expect((n as any).message.length).toBeLessThan(300);
    // normalizer has one job (normalize text) — the ⚠️ prefix is bootstrap's call, by level.
    expect((n as any).message).not.toMatch(/^[⚠❌]/u);
  });
  it('stop-failure → attention message with error_type, no emoji prefix', () => {
    const n = parseHookInput('stop-failure', { cwd: '/x', session_id: 's', error_type: 'rate_limit' });
    expect((n as any).message).toContain('rate_limit');
    expect((n as any).message).not.toMatch(/^[⚠❌]/u);
  });

  describe('post-tool-use-failure with empty tool_error → droppable (noise, e.g. grep no-match / test false / diff --quiet)', () => {
    it('tool_error missing → droppable: true', () => {
      const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash' });
      expect((n as any).droppable).toBe(true);
    });
    it('tool_error: "" (empty string) → droppable: true', () => {
      const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash', tool_error: '' });
      expect((n as any).droppable).toBe(true);
    });
    it('tool_error: "   " (whitespace only) → droppable: true', () => {
      const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash', tool_error: '   \n\t ' });
      expect((n as any).droppable).toBe(true);
    });
    it('tool_error: {} (empty object → JSON.stringify "{}") → droppable: true', () => {
      const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash', tool_error: {} });
      expect((n as any).droppable).toBe(true);
    });
    it('tool_error: null → droppable: true', () => {
      const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash', tool_error: null });
      expect((n as any).droppable).toBe(true);
    });

    // Fix 3b: droppable only suppresses IM (see bootstrap.ts's hook.notify
    // handler) — the dashboard still displays this attention's message
    // verbatim, so `Bash failed: ""` (bare empty quotes) is ugly there. Empty
    // errors get a clean human sentence instead; non-empty errors keep the
    // original "<tool> failed: <err>" shape untouched.
    it('empty tool_error → clean message, no bare quotes ("Bash failed (no error output)")', () => {
      const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash' });
      expect((n as any).message).toBe('Bash failed (no error output)');
      expect((n as any).message).not.toContain('""');
    });
    it('whitespace-only tool_error → same clean message', () => {
      const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash', tool_error: '   \n\t ' });
      expect((n as any).message).toBe('Bash failed (no error output)');
    });
  });

  it('post-tool-use-failure with real content ("permission denied") → not droppable, message carries the reason', () => {
    const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash', tool_error: 'permission denied' });
    expect((n as any).droppable).toBeFalsy();
    expect((n as any).message).toContain('permission denied');
  });

  it('stop-failure is unaffected — never droppable (Stop hook failing itself, not tool_error-based)', () => {
    const n = parseHookInput('stop-failure', { cwd: '/x', session_id: 's', error_type: 'rate_limit' });
    expect((n as any).droppable).toBeUndefined();
  });
});

describe('effectiveMode(缺省 notify 的单一真相)', () => {
  it("透传 'off' 与 'full'", () => {
    expect(effectiveMode('off')).toBe('off');
    expect(effectiveMode('full')).toBe('full');
  });
  it("其余一律 → 'notify'(未设 / 未知 / null)", () => {
    expect(effectiveMode(undefined)).toBe('notify');
    expect(effectiveMode('notify')).toBe('notify');
    expect(effectiveMode('bogus')).toBe('notify');
    expect(effectiveMode(null)).toBe('notify');
  });
});

describe('sessionStartOut(欢迎提示)', () => {
  it('claude + IM 未配置 → additionalContext', () => {
    const o = JSON.parse(sessionStartOut('claude', false, 'full'));
    expect(o.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(o.hookSpecificOutput.additionalContext).toContain('帮我配置 tlive');
  });
  it('claude + 已配置 + full → {}', () => expect(sessionStartOut('claude', true, 'full')).toBe('{}'));
  it('claude + 已配置 + notify → 提示远程审批是关的(引导 tlive mode full)', () => {
    const o = JSON.parse(sessionStartOut('claude', true, 'notify'));
    expect(o.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(o.hookSpecificOutput.additionalContext).toContain('tlive mode full');
  });
  it('claude + IM 未配置 → 仍是配置引导(与 mode 无关,先配 IM)', () => {
    const o = JSON.parse(sessionStartOut('claude', false, 'notify'));
    expect(o.hookSpecificOutput.additionalContext).toContain('帮我配置 tlive');
  });
  it('codex → 恒 {}(输出 schema deny_unknown_fields)', () => {
    expect(sessionStartOut('codex', false, 'notify')).toBe('{}');
    expect(sessionStartOut('codex', true, 'full')).toBe('{}');
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
