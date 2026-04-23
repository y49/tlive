import { describe, it, expect } from 'vitest';
import { replyMarkupToDiscord, buttonsToComponents } from '../../../src/platform/discord/renderer.js';

describe('discord/renderer', () => {
  it('maps inline_keyboard to ActionRow components', () => {
    const rows = buttonsToComponents([
      [
        { text: 'Allow', callbackData: 'perm:allow:1', style: 'primary' },
        { text: 'Deny', callbackData: 'perm:deny:1', style: 'danger' },
      ],
    ]);
    expect(rows).toHaveLength(1);
    const row0 = rows[0]!.toJSON();
    expect(row0.components).toHaveLength(2);
    // Primary style = 1, Danger = 4
    expect((row0.components[0] as { style: number }).style).toBe(1);
    expect((row0.components[1] as { style: number }).style).toBe(4);
  });

  it('link buttons use url instead of customId', () => {
    const rows = buttonsToComponents([[{ text: 'Open', url: 'https://e.com' }]]);
    const json = rows[0]!.toJSON();
    // Link style = 5
    expect((json.components[0] as { style: number }).style).toBe(5);
    expect((json.components[0] as unknown as { url: string }).url).toBe('https://e.com');
  });

  it('replyMarkupToDiscord: non-inline_keyboard → undefined', () => {
    expect(replyMarkupToDiscord({ type: 'modal', formFields: [] })).toBeUndefined();
    expect(replyMarkupToDiscord(undefined)).toBeUndefined();
  });
});
