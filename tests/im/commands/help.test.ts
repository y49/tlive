import { describe, it, expect } from 'vitest';
import { helpCmd } from '../../../src/im/commands/help.js';
import { buildCtx } from './_helpers.js';

describe('/help', () => {
  it('emits grouped command catalog with workspace + session sections', async () => {
    const { ctx, replies } = buildCtx({ workspace: { activeSessionId: null } });
    await helpCmd.run(ctx, []);
    const out = replies[0]!;
    expect(out).toContain('tlive 命令');
    expect(out).toContain('会话 (workspace-scoped)');
    expect(out).toContain('当前对话 (session-scoped)');
    // Spot-check command entries
    expect(out).toContain('/new');
    expect(out).toContain('/sessions');
    expect(out).toContain('/workspace');
    expect(out).toContain('/cost');
    expect(out).toContain('/find');
    expect(out).toContain('/stop');
    expect(out).toContain('/model');
    expect(out).toContain('/mode');
    expect(out).toContain('/think');
    expect(out).toContain('/perm');
    expect(out).toContain('/budget');
  });

  it('mentions inline keyboards / buttons hint', async () => {
    const { ctx, replies } = buildCtx({ workspace: { activeSessionId: null } });
    await helpCmd.run(ctx, []);
    expect(replies[0]).toMatch(/按钮/);
  });

  it('omits SDK section when no active session', async () => {
    const { ctx, replies } = buildCtx({ workspace: { activeSessionId: null } });
    await helpCmd.run(ctx, []);
    expect(replies[0]).not.toContain('SDK 内置命令');
  });

  it('appends SDK supportedCommands when active session is local', async () => {
    const fakeSession = {
      id: 'sess1',
      kind: 'local',
      shortAlias: 'sess1',
      supportedCommands: async () => [{ name: 'compact' }, { name: 'clear' }],
    };
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess1' },
      activeSession: fakeSession as never,
    });
    await helpCmd.run(ctx, []);
    expect(replies[0]).toContain('SDK 内置命令');
    expect(replies[0]).toContain('/compact');
    expect(replies[0]).toContain('/clear');
  });

  it('handles supportedCommands throwing without breaking help', async () => {
    const fakeSession = {
      id: 'sess1',
      kind: 'local',
      shortAlias: 'sess1',
      supportedCommands: async () => { throw new Error('boom'); },
    };
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess1' },
      activeSession: fakeSession as never,
    });
    await helpCmd.run(ctx, []);
    // Help still emits; SDK section just absent
    expect(replies[0]).toContain('tlive 命令');
    expect(replies[0]).not.toContain('SDK 内置命令');
  });

  it('warn-logs when supportedCommands throws (observability dead zone fix)', async () => {
    const fakeSession = {
      id: 'sess1',
      kind: 'local',
      shortAlias: 'sess1',
      supportedCommands: async () => { throw new Error('sdk down'); },
    };
    const { ctx, logs } = buildCtx({
      withLogger: true,
      workspace: { activeSessionId: 'sess1' },
      activeSession: fakeSession as never,
    });
    await helpCmd.run(ctx, []);
    const warned = logs.find((l) => l.msg === 'help: SDK supportedCommands failed');
    expect(warned).toBeDefined();
    expect(warned!.level).toBe('warn');
    expect(warned!.fields?.reason).toBe('sdk down');
  });
});
