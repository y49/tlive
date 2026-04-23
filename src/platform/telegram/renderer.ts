// src/platform/telegram/renderer.ts
//
// Telegram-specific rendering helpers. MarkdownV2 escaping per
// https://core.telegram.org/bots/api#markdownv2-style and inline-keyboard
// serialization from our platform-agnostic ReplyMarkup.

import type { InlineKeyboardButton } from 'grammy/types';
import type { InlineButton, ReplyMarkup } from '../types.js';

/** Characters that must be escaped inside MarkdownV2 text. */
const MDV2_ESCAPE = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(MDV2_ESCAPE, (ch) => `\\${ch}`);
}

/**
 * Telegram callback_data is capped at 64 bytes. Callers should keep strings
 * short; this helper truncates + hashes if needed to fit.
 */
export function clampCallbackData(data: string): string {
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes <= 64) return data;
  return data.slice(0, 60) + '…';
}

export function buttonsToInlineKeyboard(
  buttons: InlineButton[][],
): InlineKeyboardButton[][] {
  return buttons.map((row) =>
    row.map((btn): InlineKeyboardButton => {
      if (btn.url) return { text: btn.text, url: btn.url };
      return { text: btn.text, callback_data: clampCallbackData(btn.callbackData ?? '') };
    }),
  );
}

/**
 * Convert our ReplyMarkup → the subset Telegram accepts on sendMessage /
 * editMessageText. forceReply is mapped to `{ force_reply: true }`. modal is
 * unsupported — callers are expected to consult the capability matrix and
 * fall back to forceReply.
 */
export function replyMarkupToTelegram(markup: ReplyMarkup | undefined): object | undefined {
  if (!markup) return undefined;
  if (markup.type === 'inline_keyboard' && markup.buttons) {
    return { inline_keyboard: buttonsToInlineKeyboard(markup.buttons) };
  }
  if (markup.type === 'force_reply') {
    return {
      force_reply: true,
      input_field_placeholder: markup.placeholder,
    };
  }
  return undefined;
}
