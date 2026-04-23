import { describe, it, expect } from 'vitest';
import { searchCmd } from '../../../src/im/commands/search.js';
import { buildCtx } from './_helpers.js';

describe('/search', () => {
  it('usage message on empty query', async () => {
    const { ctx, replies } = buildCtx();
    await searchCmd.run(ctx, []);
    expect(replies[0]).toMatch(/Usage: \/search/);
  });

  it('reports no matches', async () => {
    const { ctx, replies } = buildCtx();
    await searchCmd.run(ctx, ['foo']);
    expect(replies[0]).toMatch(/No matches/);
  });

  it('finds matches in live session titles', async () => {
    const { ctx, replies } = buildCtx({
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', title: 'fix refactor' } as never,
    });
    await searchCmd.run(ctx, ['refactor']);
    expect(replies[0]).toContain('abcd1234');
  });
});
