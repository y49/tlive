import { describe, it, expect } from 'vitest';
import { attachLastCmd } from '../../../src/im/commands/attach-last.js';
import { buildCtx } from './_helpers.js';
import type { AttachmentStore, Attachment } from '../../../src/attachment/store.js';

function fakeAttachments(list: Attachment[]): AttachmentStore {
  return {
    listForSession() { return list; },
  } as unknown as AttachmentStore;
}

describe('/attach-last', () => {
  it('reports when AttachmentStore missing', async () => {
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234' } as never,
    });
    await attachLastCmd.run(ctx, []);
    expect(replies[0]).toMatch(/AttachmentStore not wired/);
  });

  it('reports no attachments when empty', async () => {
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234' } as never,
    });
    ctx.attachments = fakeAttachments([]);
    await attachLastCmd.run(ctx, []);
    expect(replies[0]).toMatch(/No outbound attachments/);
  });

  it('reports the last outbound attachment', async () => {
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234' } as never,
    });
    ctx.attachments = fakeAttachments([
      { id: 'a1', sessionId: 'sess-0000-0000-0000-0000', name: 'x.txt', mime: 'text/plain', sizeBytes: 10, path: '/tmp/x.txt', direction: 'outbound', createdAt: new Date().toISOString() } as Attachment,
    ]);
    await attachLastCmd.run(ctx, []);
    expect(replies[0]).toContain('x.txt');
  });
});
