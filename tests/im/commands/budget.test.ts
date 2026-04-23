import { describe, it, expect } from 'vitest';
import { budgetCmd } from '../../../src/im/commands/budget.js';
import { buildCtx } from './_helpers.js';

describe('/budget', () => {
  it('shows unset', async () => {
    const { ctx, replies } = buildCtx();
    await budgetCmd.run(ctx, []);
    expect(replies[0]).toMatch(/\(unset\)/);
  });

  it('rejects negative', async () => {
    const { ctx, replies } = buildCtx();
    await budgetCmd.run(ctx, ['-1']);
    expect(replies[0]).toMatch(/Usage/);
  });

  it('sets daily cap', async () => {
    const { ctx, replies } = buildCtx();
    await budgetCmd.run(ctx, ['2.5']);
    expect(replies[0]).toMatch(/\$2\.50/);
  });
});
