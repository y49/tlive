import { describe, it, expect } from 'vitest';
import { ReplyRenderer } from '../../src/im/reply.js';
import { FakeAdapter } from './fake-adapter.js';

describe('ReplyRenderer — telegram primary', () => {
  it('first delta sends; subsequent deltas edit the same msgId', async () => {
    const adapter = new FakeAdapter('telegram');
    const r = new ReplyRenderer(adapter, { chatId: 'c', role: 'primary', channelType: 'telegram' });
    await r.onTextDelta('Hello');
    await r.onTextDelta('Hello world');
    expect(adapter.calls[0].kind).toBe('send');
    expect(adapter.calls[1].kind).toBe('edit');
    expect((adapter.calls[1].args.text as string)).toContain('Hello world');
  });

  it('onTextComplete with text shorter than max emits one final edit', async () => {
    const adapter = new FakeAdapter('telegram');
    const r = new ReplyRenderer(adapter, { chatId: 'c', role: 'primary', channelType: 'telegram' });
    await r.onTextDelta('partial');
    await r.onTextComplete('partial complete');
    expect(adapter.calls.at(-1)!.args.text).toContain('partial complete');
  });

  it('emits markdown bold/italic/code as HTML tags', async () => {
    const adapter = new FakeAdapter('telegram');
    const r = new ReplyRenderer(adapter, { chatId: 'c', role: 'primary', channelType: 'telegram' });
    await r.onTextComplete('**bold** *italic* `code`');
    const text = adapter.calls[0].args.text as string;
    expect(text).toContain('<b>bold</b>');
    expect(text).toContain('<i>italic</i>');
    expect(text).toContain('<code>code</code>');
  });

  it('preserves user text containing the literal substring "FENCE0"', async () => {
    const adapter = new FakeAdapter('telegram');
    const r = new ReplyRenderer(adapter, { chatId: 'c', role: 'primary', channelType: 'telegram' });
    await r.onTextComplete('see FENCE0 here\n```ts\nx\n```\nend');
    const text = adapter.calls[0].args.text as string;
    expect(text).toContain('see FENCE0 here');
    expect(text).toContain('end');
    expect(text).toMatch(/<pre><code/);
  });

  it('overflow send failure does not duplicate the chunk on subsequent deltas', async () => {
    const adapter = new FakeAdapter('telegram');
    const realSend = adapter.send.bind(adapter);
    let callCount = 0;
    adapter.send = async (msg) => {
      callCount++;
      // First send (head) succeeds. Second send (first overflow chunk) fails.
      // Subsequent sends succeed.
      if (callCount === 2) throw new Error('rate limited');
      return await realSend(msg);
    };
    const r = new ReplyRenderer(adapter, { chatId: 'c', role: 'primary', channelType: 'telegram' });
    const text1 = 'a'.repeat(5000); // 2 chunks
    await r.onTextComplete(text1);
    const text2 = 'a'.repeat(8000); // 2 chunks
    await r.onTextComplete(text2);
    // We expect: head send (success), overflow send (failed), then on the 2nd
    // delta only chunks beyond what was attempted are sent. The failed chunk
    // is NOT retried (it'd be a duplicate). Total wire sends: 1 (head) + 1
    // (failed overflow attempt) + chunks beyond = 4 total adapter.send calls,
    // since text2 = 2 chunks total → no NEW chunks beyond what was attempted.
    expect(callCount).toBe(2);
  });

  it('text >4096 chars splits into multiple sends linked via replyToMessageId', async () => {
    const adapter = new FakeAdapter('telegram');
    const r = new ReplyRenderer(adapter, { chatId: 'c', role: 'primary', channelType: 'telegram' });
    const long = 'a'.repeat(5000);
    await r.onTextComplete(long);
    const sends = adapter.calls.filter(c => c.kind === 'send');
    expect(sends.length).toBeGreaterThanOrEqual(2);
    expect(sends[1].args.replyToMessageId).toBe(sends[0].returnedId);
  });

  it('swallows adapter.edit errors via stderr breadcrumb', async () => {
    const adapter = new FakeAdapter('telegram');
    const r = new ReplyRenderer(adapter, { chatId: 'c', role: 'primary', channelType: 'telegram' });
    await r.onTextDelta('x');
    adapter.edit = async () => { throw new Error('Bad Request: too long'); };
    await expect(r.onTextDelta('xy')).resolves.toBeUndefined();
  });
});

describe('ReplyRenderer — telegram mirror', () => {
  it('buffers deltas + emits ONE send on onTextComplete with final text', async () => {
    const adapter = new FakeAdapter('telegram');
    const r = new ReplyRenderer(adapter, { chatId: 'c', role: 'mirror', channelType: 'telegram' });
    await r.onTextDelta('a');
    await r.onTextDelta('ab');
    await r.onTextComplete('abc');
    const sends = adapter.calls.filter(c => c.kind === 'send');
    expect(sends).toHaveLength(1);
    expect((sends[0].args.text as string)).toContain('abc');
    expect(adapter.calls.filter(c => c.kind === 'edit')).toHaveLength(0);
  });

  it('mirror without onTextComplete emits no send (incomplete turn aborted)', async () => {
    const adapter = new FakeAdapter('telegram');
    const r = new ReplyRenderer(adapter, { chatId: 'c', role: 'mirror', channelType: 'telegram' });
    await r.onTextDelta('a');
    await r.onTextDelta('ab');
    expect(adapter.calls.filter(c => c.kind === 'send')).toHaveLength(0);
  });
});

describe('ReplyRenderer — feishu primary', () => {
  it('first delta sendCard; subsequent updateCard on same msgId', async () => {
    const adapter = new FakeAdapter('feishu');
    const r = new ReplyRenderer(adapter, { chatId: 'c', role: 'primary', channelType: 'feishu' });
    await r.onTextDelta('hi');
    await r.onTextDelta('hi there');
    expect(adapter.calls[0].kind).toBe('sendCard');
    expect(adapter.calls[1].kind).toBe('updateCard');
  });

  it('feishu mirror buffers and sendCard once on complete', async () => {
    const adapter = new FakeAdapter('feishu');
    const r = new ReplyRenderer(adapter, { chatId: 'c', role: 'mirror', channelType: 'feishu' });
    await r.onTextDelta('a');
    await r.onTextComplete('abc');
    const sendCards = adapter.calls.filter(c => c.kind === 'sendCard');
    expect(sendCards).toHaveLength(1);
    expect((sendCards[0].args.card as any).body.elements[0].content).toContain('abc');
    expect(adapter.calls.filter(c => c.kind === 'updateCard')).toHaveLength(0);
  });
});
