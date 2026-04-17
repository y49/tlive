import { describe, it, expect, vi } from 'vitest';
import { DeliveryLayer } from '../delivery/delivery.js';
import { chunkMarkdown, chunkByParagraph, labelMultipartChunks, prependMultipartIntro, prepareMultipartText } from '../delivery/delivery.js';
import type { BaseChannelAdapter } from '../channels/base.js';

function mockAdapter(): BaseChannelAdapter {
  return {
    channelType: 'telegram',
    send: vi.fn().mockResolvedValue({ messageId: '1', success: true }),
    editMessage: vi.fn(), start: vi.fn(), stop: vi.fn(),
    consumeOne: vi.fn(), validateConfig: vi.fn(), isAuthorized: vi.fn(),
  } as any;
}

describe('DeliveryLayer', () => {
  it('delivers short message in one chunk', async () => {
    const adapter = mockAdapter();
    const layer = new DeliveryLayer();
    await layer.deliver(adapter, 'chat1', 'hello');
    expect(adapter.send).toHaveBeenCalledOnce();
  });

  it('chunks long message at platform limit', async () => {
    const adapter = mockAdapter();
    const layer = new DeliveryLayer();
    const longMsg = 'x'.repeat(5000); // Telegram limit is 4096
    await layer.deliver(adapter, 'chat1', longMsg, { platformLimit: 4096 });
    expect((adapter.send as any).mock.calls.length).toBeGreaterThan(1);
  });

  it('retries on failure', async () => {
    const adapter = mockAdapter();
    let callCount = 0;
    (adapter.send as any).mockImplementation(() => {
      callCount++;
      if (callCount < 3) throw new Error('server error');
      return { messageId: '1', success: true };
    });
    const layer = new DeliveryLayer();
    await layer.deliver(adapter, 'chat1', 'hello');
    expect(callCount).toBe(3);
  });

  it('gives up after max retries', async () => {
    const adapter = mockAdapter();
    (adapter.send as any).mockRejectedValue(new Error('fail'));
    const layer = new DeliveryLayer();
    await expect(layer.deliver(adapter, 'chat1', 'hello')).rejects.toThrow('fail');
  });
});

describe('fence-aware chunking', () => {
  it('keeps heading with following paragraph when possible', () => {
    const text = '# Heading\nBody paragraph that should stay attached.';
    const chunks = chunkByParagraph(text, 200);
    expect(chunks).toEqual(['# Heading\nBody paragraph that should stay attached.']);
  });

  it('labels multipart chunks', () => {
    expect(labelMultipartChunks(['one', 'two'])).toEqual(['[1/2]\none', '[2/2]\ntwo']);
  });

  it('prepends intro to first multipart chunk', () => {
    expect(prependMultipartIntro(['one', 'two'], 'Intro')).toEqual(['Intro\n\none', 'two']);
  });

  it('prepares multipart text with intro and labels', () => {
    expect(prepareMultipartText('one\n\n' + 'two'.repeat(100), 50, { intro: 'Intro' })[0]).toContain('Intro');
    expect(prepareMultipartText('one\n\n' + 'two'.repeat(100), 50, { intro: 'Intro' })[0]).toContain('[1/');
  });

  it('can prepare multipart text without labels', () => {
    const chunks = prepareMultipartText('one\n\n' + 'two'.repeat(100), 50, { intro: 'Intro', labelParts: false });
    expect(chunks[0]).toContain('Intro');
    expect(chunks[0]).not.toContain('[1/');
  });

  it('preserves code block fences across chunks', () => {
    const text = '# Title\n```js\n' + 'let x = 1;\n'.repeat(100) + '```\nEnd.';
    const chunks = chunkMarkdown(text, 200);
    for (const chunk of chunks) {
      const opens = (chunk.match(/```/g) || []).length;
      expect(opens % 2).toBe(0);
    }
  });

  it('reopens code block in next chunk', () => {
    const text = '```\n' + 'line\n'.repeat(50) + '```';
    const chunks = chunkMarkdown(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].trimEnd().endsWith('```')).toBe(true);
    expect(chunks[1].startsWith('```')).toBe(true);
  });

  it('handles text without code blocks normally', () => {
    const text = 'Hello\nWorld\nFoo\nBar';
    const chunks = chunkMarkdown(text, 12);
    expect(chunks.join('\n')).toContain('Hello');
    expect(chunks.join('\n')).toContain('Bar');
  });

  it('returns single chunk if within limit', () => {
    expect(chunkMarkdown('short text', 100)).toEqual(['short text']);
  });

  it('splits long line without code block', () => {
    const chunks = chunkMarkdown('A'.repeat(300), 100);
    expect(chunks.length).toBe(3);
  });
});
