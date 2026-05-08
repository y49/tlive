import { describe, it, expect, vi } from 'vitest';
import { renderPicker, parsePickerCallback } from '../../src/im/picker/picker.js';

describe('renderPicker', () => {
  it('renders a reply with title and inline keyboard of items', async () => {
    const reply = vi.fn();
    const ctx = { reply } as never;
    await renderPicker(ctx, {
      title: '选模型',
      items: [
        { label: 'Opus 4.7', value: 'claude-opus-4-7' },
        { label: 'Sonnet 4.6', value: 'claude-sonnet-4-6', marker: '✅' },
      ],
      callbackPrefix: 'model:set',
    });
    expect(reply).toHaveBeenCalledTimes(1);
    const [text, opts] = reply.mock.calls[0];
    expect(text).toContain('选模型');
    expect(opts.replyMarkup.type).toBe('inline_keyboard');
    expect(opts.replyMarkup.buttons[0][0].text).toBe('Opus 4.7');
    expect(opts.replyMarkup.buttons[0][0].callbackData).toBe('model:set:claude-opus-4-7');
    expect(opts.replyMarkup.buttons[1][0].text).toBe('✅ Sonnet 4.6');
  });

  it('disabled items render but with no callbackData', async () => {
    const reply = vi.fn();
    await renderPicker({ reply } as never, {
      title: 't',
      items: [{ label: 'gone', value: 'g', disabled: true }],
      callbackPrefix: 'p',
    });
    const [, opts] = reply.mock.calls[0];
    expect(opts.replyMarkup.buttons[0][0].callbackData).toBeUndefined();
  });
});

describe('parsePickerCallback', () => {
  it('splits prefix and value', () => {
    expect(parsePickerCallback('model:set:claude-opus-4-7'))
      .toEqual({ prefix: 'model:set', value: 'claude-opus-4-7' });
  });
  it('value can contain colons', () => {
    expect(parsePickerCallback('mode:set:bypassPermissions:extra'))
      .toEqual({ prefix: 'mode:set', value: 'bypassPermissions:extra' });
  });
  it('returns null for malformed', () => {
    expect(parsePickerCallback('justone')).toBeNull();
  });
});
