import { describe, it, expect } from 'vitest';
import { mirrorCmd } from '../../../src/im/commands/mirror.js';
import { buildCtx } from './_helpers.js';

describe('/mirror', () => {
  it('list returns current bindings', async () => {
    const { ctx, replies } = buildCtx();
    await mirrorCmd.run(ctx, ['list']);
    expect(replies[0]).toContain('Mirror bindings');
  });

  it('add primary records a new binding', async () => {
    const { ctx, replies, workspaceCalls } = buildCtx();
    await mirrorCmd.run(ctx, ['add', 'primary']);
    expect(workspaceCalls.some((c) => c.method === 'addBinding')).toBe(true);
    expect(replies[0]).toMatch(/Added primary binding/);
  });
});
