import { describe, it, expect } from 'vitest';
import { skillCmd } from '../../../src/im/commands/skill.js';
import { buildCtx } from './_helpers.js';

describe('/skill', () => {
  it('list is not yet wired', async () => {
    const { ctx, replies } = buildCtx();
    await skillCmd.run(ctx, ['list']);
    expect(replies[0]).toMatch(/TODO T9/);
  });

  it('install requires arg', async () => {
    const { ctx, replies } = buildCtx();
    await skillCmd.run(ctx, ['install']);
    expect(replies[0]).toMatch(/Usage/);
  });
});
