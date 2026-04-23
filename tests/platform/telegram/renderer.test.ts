import { describe, it, expect } from 'vitest';
import { escapeMarkdownV2, buttonsToInlineKeyboard, replyMarkupToTelegram, clampCallbackData } from '../../../src/platform/telegram/renderer.js';

describe('telegram/renderer', () => {
  it('escapes MarkdownV2 special characters', () => {
    expect(escapeMarkdownV2('hello_world!')).toBe('hello\\_world\\!');
    expect(escapeMarkdownV2('[link](url)')).toBe('\\[link\\]\\(url\\)');
  });

  it('clamps callbackData exceeding 64 bytes', () => {
    const long = 'x'.repeat(100);
    expect(clampCallbackData(long).length).toBeLessThanOrEqual(64);
  });

  it('buttonsToInlineKeyboard maps url + callback_data', () => {
    const kbd = buttonsToInlineKeyboard([
      [{ text: 'A', callbackData: 'cb-a' }, { text: 'Link', url: 'https://e.com' }],
    ]);
    expect(kbd).toEqual([[
      { text: 'A', callback_data: 'cb-a' },
      { text: 'Link', url: 'https://e.com' },
    ]]);
  });

  it('replyMarkupToTelegram: force_reply', () => {
    const m = replyMarkupToTelegram({ type: 'force_reply', placeholder: 'Type...' });
    expect(m).toEqual({ force_reply: true, input_field_placeholder: 'Type...' });
  });

  it('replyMarkupToTelegram: modal → undefined (unsupported)', () => {
    expect(replyMarkupToTelegram({ type: 'modal', formFields: [] })).toBeUndefined();
  });
});
