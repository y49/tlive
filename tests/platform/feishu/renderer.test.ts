import { describe, it, expect } from 'vitest';
import { buildInlineCard } from '../../../src/platform/feishu/renderer.js';

describe('feishu/renderer', () => {
  it('builds markdown card with action row for inline_keyboard', () => {
    const card = buildInlineCard('hello', {
      type: 'inline_keyboard',
      buttons: [[
        { text: 'Allow', callbackData: 'perm:allow:1', style: 'primary' },
        { text: 'Open', url: 'https://e.com' },
      ]],
    });
    expect(card.elements[0]).toMatchObject({ tag: 'markdown', content: 'hello' });
    const action = card.elements[1] as { tag: string; actions: { tag: string; url?: string; value?: { callback_data: string } }[] };
    expect(action.tag).toBe('action');
    expect(action.actions[0]!.value).toEqual({ callback_data: 'perm:allow:1' });
    expect(action.actions[1]!.url).toBe('https://e.com');
  });

  it('optional title → header block', () => {
    const card = buildInlineCard('x', undefined, 'Title');
    expect(card.header?.title.content).toBe('Title');
  });
});
