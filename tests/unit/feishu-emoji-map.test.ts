import { describe, it, expect } from 'vitest';
import { feishuEmojiType } from '../../src/platform/feishu/emoji-map.js';

describe('feishuEmojiType', () => {
  it('maps received-phase 👀 → EYES', () => {
    expect(feishuEmojiType('👀')).toBe('EYES');
  });
  it('maps working-phase ⏳ → HOURGLASS_FLOWING_SAND', () => {
    expect(feishuEmojiType('⏳')).toBe('HOURGLASS_FLOWING_SAND');
  });
  it('maps done-phase ✅ → DONE', () => {
    expect(feishuEmojiType('✅')).toBe('DONE');
  });
  it('maps error-phase ❌ → X', () => {
    expect(feishuEmojiType('❌')).toBe('X');
  });
  it('maps revert-phase 🤔 → THINKING', () => {
    expect(feishuEmojiType('🤔')).toBe('THINKING');
  });
  it('returns null for unmapped emoji', () => {
    expect(feishuEmojiType('🚀')).toBeNull();
    expect(feishuEmojiType('hello')).toBeNull();
    expect(feishuEmojiType('')).toBeNull();
  });
});
