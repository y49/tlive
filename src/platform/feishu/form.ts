// src/platform/feishu/form.ts
//
// Form card blocks for Feishu elicitation. Feishu's "form" element groups
// inputs + a submit action into a single interactive card. Users click
// submit → a card-action event fires with `form_value` payload.

import type { FormField } from '../types.js';
import type { FeishuCard } from './renderer.js';

export function buildFormCard(title: string, fields: FormField[], submitId: string): FeishuCard {
  const formElements = fields.map((f) => ({
    tag: 'input',
    name: f.name,
    label: { tag: 'plain_text', content: f.label },
    placeholder: f.placeholder ? { tag: 'plain_text', content: f.placeholder } : undefined,
    required: f.required ?? false,
    default_value: f.default ?? '',
  }));
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements: [
      {
        tag: 'form',
        name: submitId,
        elements: [
          ...formElements,
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                form_action_type: 'submit',
                type: 'primary',
                text: { tag: 'plain_text', content: 'Submit' },
                value: { callback_data: `elic:submit:${submitId}` },
              },
              {
                tag: 'button',
                form_action_type: 'reset',
                type: 'default',
                text: { tag: 'plain_text', content: 'Cancel' },
                value: { callback_data: `elic:decline:${submitId}` },
              },
            ],
          },
        ],
      },
    ],
  };
}
