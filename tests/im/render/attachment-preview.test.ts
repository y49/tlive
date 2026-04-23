import { describe, it, expect } from 'vitest';
import { AttachmentPreviewRenderer, renderAttachmentCaption, attachmentButtons } from '../../../src/im/render/attachment-preview.js';
import { CAPABILITIES } from '../../../src/im/capability-matrix.js';
import { newSessionRenderState } from '../../../src/im/render/types.js';
import { FakeAdapter } from '../fake-adapter.js';

function makeState() {
  return newSessionRenderState({
    sessionId: 's1', shortAlias: 'abcd',
    workspaceId: 'w1', workspaceName: 'ws',
    targets: [{ channelType: 'telegram', chatId: '10', role: 'primary' }],
  });
}

describe('attachment-preview', () => {
  it('caption includes name + human size', () => {
    expect(renderAttachmentCaption({
      attachmentId: 'a1', name: 'log.txt', mime: 'text/plain', sizeBytes: 2048, path: '/tmp/log.txt',
    })).toBe('📎 log.txt · 2.0KB');
  });

  it('buttons carry download callback', () => {
    const m = attachmentButtons('a1');
    expect(m.buttons?.[0]?.[0]?.callbackData).toBe('attach:download:a1');
  });

  it('renderer uploads attachment via adapter', async () => {
    const adapter = new FakeAdapter('telegram');
    const state = makeState();
    const target = state.targets[0]!;
    const r = new AttachmentPreviewRenderer({ adapter, capabilities: CAPABILITIES.telegram, session: state, target });
    await r.onProduced({
      attachmentId: 'a1', name: 'out.md', mime: 'text/markdown', sizeBytes: 100, path: '/tmp/out.md',
    });
    expect(adapter.byKind('sendAttachment')).toHaveLength(1);
  });
});
