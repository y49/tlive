/**
 * Feishu CardKit streaming session.
 * Creates a card with streaming_mode=true, sends element-level updates,
 * and closes streaming when complete.
 */

import { normalizeForIM } from '../markdown/common.js';

export interface FeishuStreamingOptions {
  client: any; // Lark SDK client
  chatId: string;
  receiveIdType?: string;
  replyToMessageId?: string;
  header?: { template: string; title: string };
}

export class FeishuStreamingSession {
  private client: any;
  private chatId: string;
  private receiveIdType: string;
  private replyToMessageId?: string;
  private header?: { template: string; title: string };
  private cardId?: string;
  private messageId?: string;
  private sequence = 0;
  private lastContent = '';
  private updateQueue: Promise<void> = Promise.resolve();
  private throttleMs = 100;
  private lastUpdateTime = 0;

  constructor(options: FeishuStreamingOptions) {
    this.client = options.client;
    this.chatId = options.chatId;
    this.receiveIdType = options.receiveIdType || 'chat_id';
    this.replyToMessageId = options.replyToMessageId;
    this.header = options.header;
  }

  get currentMessageId(): string | undefined {
    return this.messageId;
  }

  /** Create card + send as message. Returns messageId. */
  async start(initialText = 'Thinking...'): Promise<string> {
    const normalizedInitialText = normalizeForIM(initialText);
    // Step 1: Create card entity with streaming enabled
    const cardJson: Record<string, unknown> = {
      schema: '2.0',
      config: {
        streaming_mode: true,
        summary: { content: '[Generating...]' },
        streaming_config: {
          print_frequency_ms: { default: 50 },
          print_step: { default: 2 },
        },
      },
      body: {
        elements: [
          { tag: 'markdown', content: normalizedInitialText, element_id: 'content' },
        ],
      },
    };

    if (this.header) {
      cardJson.header = {
        title: { tag: 'plain_text', content: this.header.title },
        template: this.header.template,
      };
    }

    const createResult = await this.client.cardkit.v1.card.create({
      data: { type: 'card_json', data: JSON.stringify(cardJson) },
    });
    this.cardId = (createResult as any)?.data?.card_id;
    if (!this.cardId) throw new Error('Failed to create streaming card');

    // Step 2: Send card as message
    const content = JSON.stringify({ type: 'card', data: { card_id: this.cardId } });
    let result: any;

    if (this.replyToMessageId) {
      result = await this.client.im.message.reply({
        path: { message_id: this.replyToMessageId },
        data: { msg_type: 'interactive', content },
      });
    } else {
      result = await this.client.im.message.create({
        params: { receive_id_type: this.receiveIdType },
        data: {
          receive_id: this.chatId,
          msg_type: 'interactive',
          content,
        },
      });
    }

    this.messageId = result?.data?.message_id ?? '';
    return this.messageId!;
  }

  /** Update the streaming card content (cumulative text). Throttled + serialized. */
  async update(fullText: string): Promise<void> {
    const normalizedText = normalizeForIM(fullText);
    if (!this.cardId || normalizedText === this.lastContent) return;
    this.lastContent = normalizedText;

    // Serialize updates to maintain sequence ordering
    this.updateQueue = this.updateQueue.then(async () => {
      const now = Date.now();
      const elapsed = now - this.lastUpdateTime;
      if (elapsed < this.throttleMs) {
        await new Promise(r => setTimeout(r, this.throttleMs - elapsed));
      }

      this.sequence++;
      try {
        await this.client.cardkit.v1.cardElement.content({
          path: { card_id: this.cardId!, element_id: 'content' },
          data: {
            content: normalizedText,
            sequence: this.sequence,
            uuid: `s_${this.cardId}_${this.sequence}`,
          },
        });
        this.lastUpdateTime = Date.now();
      } catch {
        // Non-fatal: stale update or rate limit
      }
    });

    await this.updateQueue;
  }

  /** Close streaming mode and set final summary. */
  async close(finalText?: string): Promise<void> {
    if (!this.cardId) return;

    // Final content update if provided
    if (finalText && finalText !== this.lastContent) {
      await this.update(finalText);
    }

    // Close streaming
    this.sequence++;
    const summary = (this.lastContent || '').slice(0, 50);
    try {
      await this.client.cardkit.v1.card.settings({
        path: { card_id: this.cardId },
        data: {
          settings: JSON.stringify({
            config: {
              streaming_mode: false,
              summary: { content: summary || 'Done' },
            },
          }),
          sequence: this.sequence,
          uuid: `c_${this.cardId}_${this.sequence}`,
        },
      });
    } catch {
      // Non-fatal
    }
  }
}
