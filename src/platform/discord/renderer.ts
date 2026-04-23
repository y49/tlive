// src/platform/discord/renderer.ts
//
// Discord-specific markup helpers. Discord supports Markdown natively (no
// escape needed beyond backticks for code blocks) and Component rows for
// buttons. callback_data is serialized as `customId`.

import { ButtonBuilder, ButtonStyle, ActionRowBuilder, type MessageActionRowComponentBuilder } from 'discord.js';
import type { InlineButton, ReplyMarkup } from '../types.js';

function styleFor(style: InlineButton['style']): ButtonStyle {
  switch (style) {
    case 'primary': return ButtonStyle.Primary;
    case 'danger': return ButtonStyle.Danger;
    default: return ButtonStyle.Secondary;
  }
}

export function buttonsToComponents(
  buttons: InlineButton[][],
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  return buttons.map((row) => {
    const builder = new ActionRowBuilder<MessageActionRowComponentBuilder>();
    for (const btn of row) {
      const b = new ButtonBuilder().setLabel(btn.text);
      if (btn.url) {
        b.setStyle(ButtonStyle.Link).setURL(btn.url);
      } else {
        b.setStyle(styleFor(btn.style)).setCustomId(btn.callbackData ?? btn.text);
      }
      builder.addComponents(b);
    }
    return builder;
  });
}

export function replyMarkupToDiscord(
  markup: ReplyMarkup | undefined,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] | undefined {
  if (!markup) return undefined;
  if (markup.type !== 'inline_keyboard' || !markup.buttons) return undefined;
  const rows = buttonsToComponents(markup.buttons);
  return rows.length > 0 ? rows : undefined;
}
