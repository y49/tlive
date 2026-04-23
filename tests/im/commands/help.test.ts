import { describe, it, expect } from 'vitest';
import { helpCmd } from '../../../src/im/commands/help.js';
import { registerCommand, resetRegistryForTests, registerCommand as rc } from '../../../src/im/command-parser.js';
import { buildCtx } from './_helpers.js';

describe('/help', () => {
  it('lists tlive commands and reports no active session', async () => {
    resetRegistryForTests();
    rc(helpCmd);
    registerCommand({ name: 'other', role: ['admin'], async run() {} });
    const { ctx, replies } = buildCtx({ workspace: { activeSessionId: null } });
    await helpCmd.run(ctx, []);
    expect(replies[0]).toContain('tlive commands');
    expect(replies[0]).toContain('/help');
    expect(replies[0]).toContain('(no active session)');
  });

  it('aggregates SDK supportedCommands when session is active', async () => {
    resetRegistryForTests();
    rc(helpCmd);
    const fakeSession = {
      id: 'sess1', kind: 'local', shortAlias: 'sess1',
      supportedCommands: async () => [{ name: 'sdkcmd' }],
    };
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess1' },
      activeSession: fakeSession as never,
    });
    await helpCmd.run(ctx, []);
    expect(replies[0]).toContain('sdkcmd');
  });
});
