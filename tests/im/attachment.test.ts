import { describe, it, expect } from 'vitest';
import { AttachmentPreview } from '../../src/im/attachment.js';
import { FakeAdapter } from './fake-adapter.js';

const tg = { channelType: 'telegram' as const, chatId: 'c', role: 'primary' as const };
const fs = { channelType: 'feishu' as const, chatId: 'c', role: 'primary' as const };

describe('AttachmentPreview', () => {
  it('telegram emits text with name + KB size', async () => {
    const adapter = new FakeAdapter('telegram');
    const ap = new AttachmentPreview(adapter, tg);
    await ap.send({ name: 'output.png', mime: 'image/png', sizeBytes: 245_760, path: '/tmp/output.png' });
    expect(adapter.calls[0].kind).toBe('send');
    const text = adapter.calls[0].args.text as string;
    expect(text).toContain('output.png');
    expect(text).toContain('240'); // 245760 / 1024 = 240
    expect(text).toMatch(/KB/);
  });

  it('telegram switches to MB for files >1MB', async () => {
    const adapter = new FakeAdapter('telegram');
    const ap = new AttachmentPreview(adapter, tg);
    await ap.send({ name: 'big.bin', mime: 'application/octet-stream', sizeBytes: 5 * 1024 * 1024, path: '/tmp/big.bin' });
    const text = adapter.calls[0].args.text as string;
    expect(text).toContain('5.0');
    expect(text).toMatch(/MB/);
  });

  it('telegram shows bytes for tiny files', async () => {
    const adapter = new FakeAdapter('telegram');
    const ap = new AttachmentPreview(adapter, tg);
    await ap.send({ name: 'x.txt', mime: 'text/plain', sizeBytes: 50, path: '/tmp/x.txt' });
    const text = adapter.calls[0].args.text as string;
    expect(text).toContain('50');
    expect(text).toMatch(/\d+\s*B(?!\w)/);
  });

  it('feishu sends a card with markdown element containing the name', async () => {
    const adapter = new FakeAdapter('feishu');
    const ap = new AttachmentPreview(adapter, fs);
    await ap.send({ name: 'r.txt', mime: 'text/plain', sizeBytes: 10, path: '/tmp/r.txt' });
    expect(adapter.calls[0].kind).toBe('sendCard');
    const card: any = adapter.calls[0].args.card;
    expect(card.body.elements.some((e: any) => e.tag === 'markdown' && /r\.txt/.test(e.content))).toBe(true);
  });

  it('feishu falls back to plain send when adapter has no sendCard', async () => {
    const adapter = new FakeAdapter('feishu');
    delete (adapter as any).sendCard;
    const ap = new AttachmentPreview(adapter, fs);
    await ap.send({ name: 'r.txt', mime: 'text/plain', sizeBytes: 10, path: '/tmp/r.txt' });
    // Should fall back to plain text send rather than throw.
    expect(adapter.calls[0].kind).toBe('send');
    expect((adapter.calls[0].args.text as string)).toContain('r.txt');
  });

  it('swallows adapter.send errors via stderr breadcrumb', async () => {
    const adapter = new FakeAdapter('telegram');
    adapter.send = async () => { throw new Error('chat not found'); };
    const ap = new AttachmentPreview(adapter, tg);
    await expect(ap.send({ name: 'a', mime: '', sizeBytes: 10, path: '' })).resolves.toBeUndefined();
  });

  it('escapes HTML in attachment name (defensive)', async () => {
    const adapter = new FakeAdapter('telegram');
    const ap = new AttachmentPreview(adapter, tg);
    await ap.send({ name: '<evil>.txt', mime: '', sizeBytes: 10, path: '' });
    const text = adapter.calls[0].args.text as string;
    expect(text).not.toContain('<evil>');
    expect(text).toContain('&lt;evil&gt;');
  });
});
