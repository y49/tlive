import { describe, it, expect } from 'vitest';
import { workspaceCmd } from '../../../src/im/commands/workspace.js';
import { buildCtx } from './_helpers.js';

describe('/workspace', () => {
  it('show prints workspace details', async () => {
    const { ctx, replies } = buildCtx();
    await workspaceCmd.run(ctx, ['show']);
    expect(replies[0]).toContain('test-ws');
    expect(replies[0]).toContain('Provider');
  });

  it('system-prompt updates append', async () => {
    const { ctx, replies, workspaceCalls } = buildCtx();
    await workspaceCmd.run(ctx, ['system-prompt', '"Be', 'concise"']);
    expect(workspaceCalls.some((c) => c.method === 'save')).toBe(true);
    expect(replies[0]).toMatch(/System prompt append updated/);
  });
});
