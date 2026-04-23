import { describe, it, expect } from 'vitest';
import { exportCmd } from '../../../src/im/commands/export.js';
import { buildCtx } from './_helpers.js';

describe('/export', () => {
  it('reports usage on missing alias', async () => {
    const { ctx, replies } = buildCtx();
    await exportCmd.run(ctx, []);
    expect(replies[0]).toMatch(/Usage/);
  });

  it('echoes the export target + default format', async () => {
    const { ctx, replies } = buildCtx({
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234' } as never,
    });
    await exportCmd.run(ctx, ['abcd1234']);
    expect(replies[0]).toMatch(/abcd1234/);
    expect(replies[0]).toContain('md');
  });

  it('accepts explicit format', async () => {
    const { ctx, replies } = buildCtx({
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234' } as never,
    });
    await exportCmd.run(ctx, ['abcd1234', 'json']);
    expect(replies[0]).toContain('json');
  });
});
