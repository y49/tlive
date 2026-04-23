import { describe, it, expect, vi } from 'vitest';
import { forkCmd } from '../../../src/im/commands/fork.js';
import { buildCtx } from './_helpers.js';

describe('/fork', () => {
  it('forks the target session with optional title', async () => {
    const forkSession = vi.fn(async (title?: string) => ({ sdkSessionId: 'new-sess-id' + (title ? '-titled' : '') }));
    const { ctx, replies } = buildCtx({
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', kind: 'local', forkSession } as never,
    });
    await forkCmd.run(ctx, ['abcd1234', 'as', '"great title"']);
    expect(forkSession).toHaveBeenCalledWith('great title');
    expect(replies[0]).toMatch(/Forked abcd1234/);
  });

  it('reports usage on missing alias', async () => {
    const { ctx, replies } = buildCtx();
    await forkCmd.run(ctx, []);
    expect(replies[0]).toMatch(/Usage/);
  });
});
