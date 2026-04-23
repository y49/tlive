import { describe, it, expect, vi } from 'vitest';
import { renameCmd } from '../../../src/im/commands/rename.js';
import { buildCtx } from './_helpers.js';

describe('/rename', () => {
  it('renames the session', async () => {
    const renameSession = vi.fn(async () => undefined);
    const { ctx, replies } = buildCtx({
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', kind: 'local', renameSession } as never,
    });
    await renameCmd.run(ctx, ['abcd1234', '"My', 'new', 'title"']);
    expect(renameSession).toHaveBeenCalledWith('My new title');
    expect(replies[0]).toMatch(/Renamed abcd1234/);
  });
});
