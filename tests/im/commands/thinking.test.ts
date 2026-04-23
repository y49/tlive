import { describe, it, expect } from 'vitest';
import { thinkingCmd } from '../../../src/im/commands/thinking.js';
import { buildCtx } from './_helpers.js';

describe('/thinking', () => {
  it('rejects invalid level', async () => {
    const { ctx, replies } = buildCtx();
    await thinkingCmd.run(ctx, ['loud']);
    expect(replies[0]).toMatch(/Invalid/);
  });

  it('sets level', async () => {
    const { ctx, replies } = buildCtx();
    await thinkingCmd.run(ctx, ['expanded']);
    expect(replies[0]).toMatch(/Thinking set to expanded/);
  });
});
