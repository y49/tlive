import { describe, it, expect } from 'vitest';
import { modeCmd } from '../../../src/im/commands/mode.js';
import { buildCtx } from './_helpers.js';

describe('/mode', () => {
  it('no-args: shows current + 4 mode buttons with ✅ on current', async () => {
    const fakeSession = {
      kind: 'local' as const,
      id: 's1',
      shortAlias: 's1',
      permissionMode: 'default' as const,
      setPermissionMode: async () => {},
    };
    const { ctx, replies, replyMarkups } = buildCtx({
      workspace: { activeSessionId: 's1' },
      activeSession: fakeSession as never,
    });
    await modeCmd.run(ctx, []);
    expect(replies[0]).toMatch(/default/);
    const buttons = (replyMarkups[0]!.buttons!).flat();
    const labels = buttons.map((b) => b.text);
    // Each mode has a button whose callbackData includes the mode name.
    ['default', 'acceptEdits', 'bypassPermissions', 'plan'].forEach((m) => {
      expect(buttons.some((b) => b.callbackData === `runtime:mode:set:${m}`)).toBe(true);
    });
    // Current mode ('default') button has ✅ marker in its text.
    const defaultBtn = buttons.find((b) => b.callbackData === 'runtime:mode:set:default');
    expect(defaultBtn?.text).toContain('✅');
    // Callback data uses runtime:mode:set:<m>
    const planBtn = buttons.find((b) => b.callbackData === 'runtime:mode:set:plan');
    expect(planBtn?.callbackData).toBe('runtime:mode:set:plan');
    void labels; // referenced above
  });

  it('no-args, no session: picker uses workspace default for ✅', async () => {
    const { ctx, replies, replyMarkups } = buildCtx({
      workspace: {
        activeSessionId: null,
        defaults: {
          provider: 'claude',
          permissionMode: 'plan',
          thinking: 'collapsed',
        } as never,
      },
    });
    await modeCmd.run(ctx, []);
    expect(replies[0]).toMatch(/plan/);
    const buttons = (replyMarkups[0]!.buttons!).flat();
    // Current mode ('plan') button has ✅ marker in its text.
    const planBtn = buttons.find((b) => b.callbackData === 'runtime:mode:set:plan');
    expect(planBtn?.text).toContain('✅');
  });

  it('with valid arg: calls setPermissionMode + persists', async () => {
    let setTo = '';
    const fakeSession = {
      kind: 'local' as const,
      id: 's1',
      shortAlias: 's1',
      permissionMode: 'default' as const,
      setPermissionMode: async (m: never) => {
        setTo = m as string;
      },
    };
    const { ctx, replies, ws, workspaceCalls } = buildCtx({
      workspace: { activeSessionId: 's1' },
      activeSession: fakeSession as never,
    });
    await modeCmd.run(ctx, ['plan']);
    expect(setTo).toBe('plan');
    expect(ws?.defaults.permissionMode).toBe('plan');
    expect(workspaceCalls.some((c) => c.method === 'save')).toBe(true);
    expect(replies[0]).toMatch(/已切到.*plan/);
  });

  it('with valid arg + no active session: still persists workspace default', async () => {
    const { ctx, replies, ws } = buildCtx({
      workspace: { activeSessionId: null },
    });
    await modeCmd.run(ctx, ['acceptEdits']);
    expect(ws?.defaults.permissionMode).toBe('acceptEdits');
    expect(replies[0]).toMatch(/已切到.*acceptEdits/);
  });

  it('with valid arg + setPermissionMode throws: replies with error', async () => {
    const fakeSession = {
      kind: 'local' as const,
      id: 's1',
      shortAlias: 's1',
      setPermissionMode: async () => {
        throw new Error('runtime offline');
      },
    };
    const { ctx, replies, ws } = buildCtx({
      workspace: { activeSessionId: 's1' },
      activeSession: fakeSession as never,
    });
    await modeCmd.run(ctx, ['plan']);
    expect(replies[0]).toMatch(/切换失败/);
    // Workspace default must NOT be persisted when setPermissionMode fails.
    expect(ws?.defaults.permissionMode).not.toBe('plan');
  });

  it('with invalid arg: rejects with valid options listed', async () => {
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: null },
    });
    await modeCmd.run(ctx, ['bogus']);
    expect(replies[0]).toMatch(/无效/);
    expect(replies[0]).toMatch(/default/);
  });

  it('no workspace: friendly prompt', async () => {
    const { ctx, replies } = buildCtx({ workspace: null });
    await modeCmd.run(ctx, []);
    expect(replies[0]).toMatch(/未绑定|工作区/);
  });
});
