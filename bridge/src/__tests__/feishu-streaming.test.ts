import { describe, it, expect, vi } from 'vitest';
import { FeishuStreamingSession } from '../channels/feishu-streaming.js';

describe('FeishuStreamingSession', () => {
  it('normalizes markdown heading spacing on start and update', async () => {
    const cardCreate = vi.fn().mockResolvedValue({ data: { card_id: 'card-1' } });
    const messageCreate = vi.fn().mockResolvedValue({ data: { message_id: 'msg-1' } });
    const cardContent = vi.fn().mockResolvedValue({});
    const cardSettings = vi.fn().mockResolvedValue({});

    const session = new FeishuStreamingSession({
      client: {
        cardkit: {
          v1: {
            card: {
              create: cardCreate,
              settings: cardSettings,
            },
            cardElement: {
              content: cardContent,
            },
          },
        },
        im: {
          message: {
            create: messageCreate,
            reply: vi.fn(),
          },
        },
      },
      chatId: 'oc_chat123',
    });

    await session.start('Hello\n## Title\nBody');
    expect(cardCreate).toHaveBeenCalledOnce();
    const createdPayload = JSON.parse(cardCreate.mock.calls[0][0].data.data);
    expect(createdPayload.body.elements[0].content).toBe('Hello\n\n**Title**\n\nBody');

    await session.update('Intro\n## Next\nBody');
    expect(cardContent).toHaveBeenCalledOnce();
    expect(cardContent.mock.calls[0][0].data.content).toBe('Intro\n\n**Next**\n\nBody');
  });
});
