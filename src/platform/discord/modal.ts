// src/platform/discord/modal.ts
//
// Discord Modal builder for elicitation. One Modal per request; fields become
// TextInput components. Discord imposes a 5-component cap on modals so we
// truncate beyond that.

import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import type { FormField } from '../types.js';

export function buildModal(
  customId: string,
  title: string,
  fields: FormField[],
): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title.slice(0, 45));
  const rows = fields.slice(0, 5).map((f) => {
    const input = new TextInputBuilder()
      .setCustomId(f.name)
      .setLabel(f.label.slice(0, 45))
      .setStyle(f.type === 'textarea' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(f.required ?? false);
    if (f.default) input.setValue(f.default);
    if (f.placeholder) input.setPlaceholder(f.placeholder);
    return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
  });
  modal.addComponents(rows);
  return modal;
}
