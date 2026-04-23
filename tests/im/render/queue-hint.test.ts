import { describe, it, expect } from 'vitest';
import { QueueHintRenderer, renderQueueHintText, queueHintButtons } from '../../../src/im/render/queue-hint.js';
import { CAPABILITIES } from '../../../src/im/capability-matrix.js';
import { FakeAdapter } from '../fake-adapter.js';

describe('queue-hint', () => {
  it('text shows position', () => {
    expect(renderQueueHintText(3)).toBe('⏭ Queued as #3');
  });

  it('cancel button carries entry id', () => {
    const m = queueHintButtons('e1');
    expect(m.buttons?.[0]?.[0]?.callbackData).toBe('queue:cancel:e1');
  });

  it('emits reply-to-inbound message', async () => {
    const adapter = new FakeAdapter('telegram');
    const r = new QueueHintRenderer({ adapter, capabilities: CAPABILITIES.telegram });
    await r.emit({ chatId: 'c1', inboundMessageId: 'm1', queuePosition: 2, queueEntryId: 'e1' });
    const send = adapter.byKind('send')[0]!;
    expect(send.args.replyToMessageId).toBe('m1');
    expect(send.args.text).toBe('⏭ Queued as #2');
  });
});
