// src/platform/feishu/renderer.ts
//
// Feishu interactive-card builder. Cards are built as JSON blocks; buttons
// carry a `value` object that we embed the callbackData into so the
// card-action event handler can retrieve it verbatim.

import type { InlineButton, ReplyMarkup } from '../types.js';

export interface FeishuCard {
  config?: { wide_screen_mode?: boolean };
  header?: { title: { tag: 'plain_text'; content: string } };
  elements: unknown[];
}

function buttonToElement(btn: InlineButton): unknown {
  if (btn.url) {
    return {
      tag: 'button',
      text: { tag: 'plain_text', content: btn.text },
      type: 'default',
      url: btn.url,
    };
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: btn.text },
    type: btn.style === 'danger' ? 'danger' : btn.style === 'primary' ? 'primary' : 'default',
    value: { callback_data: btn.callbackData ?? '' },
  };
}

export function buildInlineCard(text: string, markup?: ReplyMarkup, title?: string): FeishuCard {
  const card: FeishuCard = {
    config: { wide_screen_mode: true },
    elements: [
      { tag: 'markdown', content: text },
    ],
  };
  if (title) card.header = { title: { tag: 'plain_text', content: title } };
  if (markup?.type === 'inline_keyboard' && markup.buttons) {
    for (const row of markup.buttons) {
      card.elements.push({
        tag: 'action',
        actions: row.map(buttonToElement),
      });
    }
  }
  return card;
}
