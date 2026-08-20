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
  it('permission_prompt → attention with permissionPrompt flag (the daemon decides what to do with it — issue #49)', () => {
    const n = parseHookInput('notification', { cwd: '/x', session_id: 's', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    expect(n).toEqual({ event: 'attention', cwd: '/x', sessionId: 's', message: 'Claude needs your permission to use Bash', permissionPrompt: true });
  });
  it('other types carry NO permissionPrompt flag', () => {
    const n = parseHookInput('notification', { cwd: '/x', session_id: 's', notification_type: 'idle_prompt', message: 'waiting' }) as any;
    expect(n.permissionPrompt).toBeUndefined();
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

/** Ground truth for the fixtures below is Claude Code's own hook schema, read
 *  out of the shipped binary (2.1.232 and 2.1.235 agree verbatim):
 *
 *    hook_event_name:"PostToolUseFailure", tool_name, tool_input, tool_use_id,
 *                                          error, is_interrupt?, duration_ms?
 *    hook_event_name:"StopFailure",        error, error_details?, last_assistant_message?
 *
 *  The field is `error`. tlive used to read `tool_error` and `error_type` —
 *  names that appear nowhere in either payload (`error_type` survives only in
 *  Claude Code's /hooks help TEXT, which is stale against its own schema). The
 *  cost was total: every tool failure normalized to an empty error ⇒ droppable
 *  ⇒ never reached IM at all, and every session error rendered as `unknown`
 *  whichever of the twelve kinds it was.
 *
 *  So: fixtures here must stay verbatim-shaped. Ten green tests kept that bug
 *  alive for a whole major version because each one fed the field name the
 *  parser wanted instead of the one Claude Code sends. A fixture that invents a
 *  field name proves the parser agrees with itself and nothing else. */
describe('failure events', () => {
  it('post-tool-use-failure → attention message with tool name + truncated error, no emoji prefix', () => {
    const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash', error: 'E'.repeat(500) });
    expect(n.event).toBe('attention');
    expect((n as any).message).toContain('Bash');
    expect((n as any).message).toContain('failed');
    // The error text itself has to survive — asserting only on "Bash" + "failed"
    // is what let `Bash failed (no error output)` pass this test for a year.
    expect((n as any).message).toContain('EEE');
    expect((n as any).message.length).toBeLessThan(300);
    // normalizer has one job (normalize text) — the ⚠️ prefix is bootstrap's call, by level.
    expect((n as any).message).not.toMatch(/^[⚠❌]/u);
  });
  it('stop-failure → attention message carrying the error kind, no emoji prefix', () => {
    const n = parseHookInput('stop-failure', { cwd: '/x', session_id: 's', error: 'rate_limit' });
    expect((n as any).message).toContain('rate_limit');
    expect((n as any).message).not.toMatch(/^[⚠❌]/u);
  });

  // `error` is an enum of twelve kinds; `error_details` is the free text behind
  // it. The kind alone tells you which bucket, never what happened — and one of
  // the twelve kinds is literally `unknown`, so without the details a real
  // "Claude Code doesn't know either" is indistinguishable from a parse miss.
  it('stop-failure → error_details is appended: the kind alone is not diagnosable', () => {
    const n = parseHookInput('stop-failure', {
      cwd: '/x', session_id: 's', error: 'authentication_failed',
      error_details: 'Invalid bearer token',
    });
    expect((n as any).message).toContain('authentication_failed');
    expect((n as any).message).toContain('Invalid bearer token');
  });
  it('stop-failure → long error_details is truncated', () => {
    const n = parseHookInput('stop-failure', { cwd: '/x', session_id: 's', error: 'server_error', error_details: 'D'.repeat(500) });
    expect((n as any).message.length).toBeLessThan(300);
  });
  it('stop-failure without error_details → the kind stands alone, no dangling separator', () => {
    const n = parseHookInput('stop-failure', { cwd: '/x', session_id: 's', error: 'overloaded' });
    expect((n as any).message).toBe('session error: overloaded');
  });
  it('stop-failure with no error field at all → unknown (payload drift, not a kind)', () => {
    const n = parseHookInput('stop-failure', { cwd: '/x', session_id: 's' });
    expect((n as any).message).toBe('session error: unknown');
  });

  // Which of the twelve kinds it is decides whether anyone has to come back to
  // the machine, and Claude Code already answers that — its own transience test
  // reads `apiErrorIsTransient === true || error === 'overloaded' || error ===
  // 'server_error'`. Only the two kinds are visible in the hook payload, so
  // that is what this mirrors. Verified against four real API errors on this
  // machine (2026-08-18/19): every one carried `error: "server_error"` behind
  // the text "API Error: Connection lost mid-response" — a network blip the
  // session recovers from, NOT something to call anyone back for.
  describe('stop-failure transience — Claude Code classifies it, tlive does not guess', () => {
    it('server_error is transient', () => {
      const n = parseHookInput('stop-failure', { cwd: '/x', session_id: 's', error: 'server_error' });
      expect((n as any).sessionError).toMatchObject({ transient: true });
    });
    it('overloaded is transient', () => {
      const n = parseHookInput('stop-failure', { cwd: '/x', session_id: 's', error: 'overloaded' });
      expect((n as any).sessionError).toMatchObject({ transient: true });
    });
    it('authentication_failed is not — nothing retries its way out of a bad key', () => {
      const n = parseHookInput('stop-failure', { cwd: '/x', session_id: 's', error: 'authentication_failed' });
      expect((n as any).sessionError).toMatchObject({ transient: false });
    });
    it('billing_error is not', () => {
      const n = parseHookInput('stop-failure', { cwd: '/x', session_id: 's', error: 'billing_error' });
      expect((n as any).sessionError).toMatchObject({ transient: false });
    });
    it('an unknown kind is not treated as transient — not knowing is not the same as knowing it will pass', () => {
      const n = parseHookInput('stop-failure', { cwd: '/x', session_id: 's' });
      expect((n as any).sessionError).toMatchObject({ transient: false });
    });
    // `text` is the same sentence as `message` minus its "session error: "
    // prefix: the desktop title already says the turn failed, so repeating it
    // in the body would spend the 90-character budget saying it twice.
    it('carries the kind + details as text, without the message prefix', () => {
      const n = parseHookInput('stop-failure', {
        cwd: '/x', session_id: 's', error: 'billing_error', error_details: 'Credit balance too low',
      });
      expect((n as any).sessionError.text).toBe('billing_error — Credit balance too low');
      expect((n as any).message).toBe('session error: billing_error — Credit balance too low');
    });
    it('a tool failure carries no sessionError — it is not a turn outcome', () => {
      const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash', error: 'boom' });
      expect((n as any).sessionError).toBeUndefined();
    });
  });

  describe('post-tool-use-failure with empty error → droppable (noise, e.g. grep no-match / test false / diff --quiet)', () => {
    it('error missing → droppable: true', () => {
      const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash' });
      expect((n as any).droppable).toBe(true);
    });
    it('error: "" (empty string) → droppable: true', () => {
      const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash', error: '' });
      expect((n as any).droppable).toBe(true);
    });
    it('error: "   " (whitespace only) → droppable: true', () => {
      const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash', error: '   \n\t ' });
      expect((n as any).droppable).toBe(true);
    });
    it('error: {} (empty object → JSON.stringify "{}") → droppable: true', () => {
      const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash', error: {} });
      expect((n as any).droppable).toBe(true);
    });
    it('error: null → droppable: true', () => {
      const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash', error: null });
      expect((n as any).droppable).toBe(true);
    });

    // Fix 3b: droppable only suppresses IM (see bootstrap.ts's hook.notify
    // handler) — the dashboard still displays this attention's message
    // verbatim, so `Bash failed: ""` (bare empty quotes) is ugly there. Empty
    // errors get a clean human sentence instead; non-empty errors keep the
    // original "<tool> failed: <err>" shape untouched.
    it('empty error → clean message, no bare quotes ("Bash failed (no error output)")', () => {
      const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash' });
      expect((n as any).message).toBe('Bash failed (no error output)');
      expect((n as any).message).not.toContain('""');
    });
    it('whitespace-only error → same clean message', () => {
      const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash', error: '   \n\t ' });
      expect((n as any).message).toBe('Bash failed (no error output)');
    });
  });

  // You pressed Esc. You were at the keyboard, you already know, and nothing is
  // waiting on you — the same rule the Codex `interrupted` outcome follows. The
  // dashboard still records it; only IM is spared.
  describe('post-tool-use-failure with is_interrupt → you did this, on purpose', () => {
    it('is_interrupt: true → droppable: true even though the error text is non-empty', () => {
      const n = parseHookInput('post-tool-use-failure', {
        cwd: '/x', session_id: 's', tool_name: 'Bash',
        error: 'The user doesn\'t want to proceed with this tool use.', is_interrupt: true,
      });
      expect((n as any).droppable).toBe(true);
    });
    it('is_interrupt: true → says interrupted, not failed', () => {
      const n = parseHookInput('post-tool-use-failure', {
        cwd: '/x', session_id: 's', tool_name: 'Bash',
        error: 'The user doesn\'t want to proceed with this tool use.', is_interrupt: true,
      });
      expect((n as any).message).toBe('Bash interrupted');
    });
  });

  // A tool failure never travels to IM — not because its text is empty, but
  // because nobody has to do anything about it: the agent gets the error back
  // and handles it on its own next turn. Seven days of real failures on this
  // machine (42 of them, 29 a bare `Exit code N` from a diff, a grep with no
  // match, a timeout, a quoting slip) contained not one that needed a human.
  // The message still carries the reason — the dashboard is where you read it.
  it('post-tool-use-failure with real content ("permission denied") → still IM-suppressed, message carries the reason for the dashboard', () => {
    const n = parseHookInput('post-tool-use-failure', { cwd: '/x', session_id: 's', tool_name: 'Bash', error: 'permission denied' });
    expect((n as any).droppable).toBe(true);
    expect((n as any).message).toContain('permission denied');
  });

  it('stop-failure is unaffected — never droppable (the turn died, that is always news)', () => {
    const n = parseHookInput('stop-failure', { cwd: '/x', session_id: 's', error: 'rate_limit' });
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
  it('claude + 已配置 + all → {}(all 也是"远程审批开着",不是该被提醒"关了"的状态)', () => {
    expect(sessionStartOut('claude', true, 'all')).toBe('{}');
  });
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

describe('effectiveMode — the posture ladder', () => {
  it('accepts all four rungs verbatim', () => {
    expect(effectiveMode('off')).toBe('off');
    expect(effectiveMode('notify')).toBe('notify');
    expect(effectiveMode('full')).toBe('full');
    expect(effectiveMode('all')).toBe('all');
  });
  it('unset / unknown / malformed still falls back to notify (the safe rung)', () => {
    expect(effectiveMode(undefined)).toBe('notify');
    expect(effectiveMode('ALL')).toBe('notify');
    expect(effectiveMode(3)).toBe('notify');
  });
});
