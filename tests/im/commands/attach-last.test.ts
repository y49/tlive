import { describe, it, expect } from 'vitest';
import { attachLastCmd } from '../../../src/im/commands/attach-last.js';
import { buildCtx } from './_helpers.js';

describe('/attach-last', () => {
  it('reports TODO when no AttachmentStore', async () => {
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234' } as never,
    });
    await attachLastCmd.run(ctx, []);
    expect(replies[0]).toMatch(/TODO T9/);
  });
});
