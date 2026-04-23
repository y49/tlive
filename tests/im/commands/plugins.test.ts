import { describe, it, expect, vi } from 'vitest';
import { pluginsCmd } from '../../../src/im/commands/plugins.js';
import { buildCtx } from './_helpers.js';

describe('/plugins', () => {
  it('reload calls session.reloadPlugins', async () => {
    const reloadPlugins = vi.fn(async () => undefined);
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', reloadPlugins } as never,
    });
    await pluginsCmd.run(ctx, ['reload']);
    expect(reloadPlugins).toHaveBeenCalled();
    expect(replies[0]).toMatch(/Plugins reloaded/);
  });
});
