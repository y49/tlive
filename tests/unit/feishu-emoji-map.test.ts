import { describe, it, expect } from 'vitest';
import { feishuEmojiType } from '../../src/platform/feishu/emoji-map.js';

describe('feishuEmojiType', () => {
  it('maps received-phase 👀 → GLANCE', () => {
    expect(feishuEmojiType('👀')).toBe('GLANCE');
  });
  it('maps processing-phase 🤔 → THINKING', () => {
    expect(feishuEmojiType('🤔')).toBe('THINKING');
  });
  it('maps done_ok-phase 👌 → OK', () => {
    expect(feishuEmojiType('👌')).toBe('OK');
  });
  it('maps done_err-phase 💔 → HEARTBROKEN', () => {
    expect(feishuEmojiType('💔')).toBe('HEARTBROKEN');
  });
  it('returns null for unmapped emoji', () => {
    expect(feishuEmojiType('🚀')).toBeNull();
    expect(feishuEmojiType('hello')).toBeNull();
    expect(feishuEmojiType('')).toBeNull();
  });
});
