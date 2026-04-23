import { describe, it, expect } from 'vitest';
import { buildModal } from '../../../src/platform/discord/modal.js';

describe('discord/modal', () => {
  it('builds a modal with text inputs up to 5 fields', () => {
    const modal = buildModal('cb-1', 'Auth', [
      { name: 'user', label: 'Username', type: 'text', required: true },
      { name: 'pass', label: 'Password', type: 'text', required: true },
    ]);
    const json = modal.toJSON();
    expect(json.custom_id).toBe('cb-1');
    expect(json.title).toBe('Auth');
    expect(json.components).toHaveLength(2);
  });

  it('truncates labels to Discord limit', () => {
    const modal = buildModal('cb-1', 'x'.repeat(100), [
      { name: 'a', label: 'x'.repeat(100), type: 'text' },
    ]);
    const json = modal.toJSON();
    expect(json.title.length).toBeLessThanOrEqual(45);
  });

  it('uses Paragraph style for textarea', () => {
    const modal = buildModal('cb-1', 'Form', [
      { name: 'body', label: 'Body', type: 'textarea' },
    ]);
    const json = modal.toJSON();
    const input = json.components[0]!.components[0] as { style: number };
    // TextInputStyle.Paragraph = 2
    expect(input.style).toBe(2);
  });
});
