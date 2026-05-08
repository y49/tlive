import { describe, it, expect } from 'vitest';
import { feishuEmojiType } from '../../src/platform/feishu/emoji-map.js';

describe('feishuEmojiType', () => {
  it('maps received-phase 👀 → EYES', () => {
    expect(feishuEmojiType('👀')).toBe('EYES');
  });
  it('maps processing-phase 🤔 → THINKING_FACE', () => {
    expect(feishuEmojiType('🤔')).toBe('THINKING_FACE');
  });
  it('maps done_ok-phase 👌 → OK', () => {
    expect(feishuEmojiType('👌')).toBe('OK');
  });
  it('maps done_err-phase 💔 → BROKEN_HEART', () => {
    expect(feishuEmojiType('💔')).toBe('BROKEN_HEART');
  });
  it('returns null for unmapped emoji', () => {
    expect(feishuEmojiType('🚀')).toBeNull();
    expect(feishuEmojiType('hello')).toBeNull();
    expect(feishuEmojiType('')).toBeNull();
  });
});
