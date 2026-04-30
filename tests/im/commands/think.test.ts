import { describe, it, expect } from 'vitest';
import { thinkCmd } from '../../../src/im/commands/think.js';
import { buildCtx } from './_helpers.js';

describe('/think', () => {
  it('rejects invalid level', async () => {
    const { ctx, replies } = buildCtx();
    await thinkCmd.run(ctx, ['loud']);
    expect(replies[0]).toMatch(/Invalid/);
  });

  it('sets level', async () => {
    const { ctx, replies } = buildCtx();
    await thinkCmd.run(ctx, ['expanded']);
    expect(replies[0]).toMatch(/Thinking set to expanded/);
  });
});
