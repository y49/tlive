import { describe, it, expect } from 'vitest';
import { sessionsCmd } from '../../../src/im/commands/sessions.js';
import { buildCtx } from './_helpers.js';

describe('/sessions', () => {
  it('reports no live sessions', async () => {
    const { ctx, replies } = buildCtx();
    await sessionsCmd.run(ctx, []);
    expect(replies[0]).toMatch(/No live sessions/);
  });

  it('lists live sessions', async () => {
    const { ctx, replies } = buildCtx({
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', title: 'demo' } as never,
    });
    await sessionsCmd.run(ctx, []);
    expect(replies[0]).toContain('abcd1234');
  });

  it('paginates with --page=2 and shows footer', async () => {
    // 20 sessions → page 1: 1-8, page 2: 9-16, page 3: 17-20
    const sessions = Array.from({ length: 19 }, (_, i) => ({
      id: `sess-${String(i + 2).padStart(4, '0')}`,
      shortAlias: `sess${String(i + 2).padStart(4, '0')}`,
      title: `t${i + 2}`,
    } as never));
    const { ctx, replies } = buildCtx({
      activeSession: { id: 'sess-0001', shortAlias: 'sess0001', title: 't1' } as never,
      sessions,
    });
    await sessionsCmd.run(ctx, ['--page=2']);
    const out = replies[0] ?? '';
    // page 2 should contain 9..16 (indices 8..15) shortAliases
    expect(out).toContain('sess0009');
    expect(out).toContain('sess0016');
    // boundary items of page 1 / page 3 must NOT appear
    expect(out).not.toContain('sess0008');
    expect(out).not.toContain('sess0017');
    expect(out).toMatch(/Page 2 of 3/);
    expect(out).toMatch(/--page=3/);
  });

  it('last page footer omits "for more" hint', async () => {
    const sessions = Array.from({ length: 19 }, (_, i) => ({
      id: `sess-${String(i + 2).padStart(4, '0')}`,
      shortAlias: `sess${String(i + 2).padStart(4, '0')}`,
      title: `t${i + 2}`,
    } as never));
    const { ctx, replies } = buildCtx({
      activeSession: { id: 'sess-0001', shortAlias: 'sess0001', title: 't1' } as never,
      sessions,
    });
    await sessionsCmd.run(ctx, ['--page=3']);
    const out = replies[0] ?? '';
    expect(out).toMatch(/Page 3 of 3/);
    expect(out).not.toMatch(/for more/);
  });
});
