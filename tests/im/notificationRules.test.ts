import { describe, it, expect } from 'vitest';
import { shouldPush, shouldAggregate, getMaxTextLength } from '../../src/im/notificationRules.js';

describe('notificationRules', () => {
  it('always pushes permission_request regardless of active state', () => {
    expect(shouldPush('permission_request', true)).toBe(true);
    expect(shouldPush('permission_request', false)).toBe(true);
  });

  it('always pushes ask_user_question', () => {
    expect(shouldPush('ask_user_question', true)).toBe(true);
  });

  it('always pushes activity_text (Claude responses should always reach IM)', () => {
    expect(shouldPush('activity_text', true)).toBe(true);
    expect(shouldPush('activity_text', false)).toBe(true);
  });

  it('suppresses activity_tool when user is active', () => {
    expect(shouldPush('activity_tool', true)).toBe(false);
    expect(shouldPush('activity_tool', false)).toBe(true);
  });

  it('aggregates activity_tool only', () => {
    expect(shouldAggregate('activity_tool')).toBe(true);
    expect(shouldAggregate('activity_text')).toBe(false);
    expect(shouldAggregate('permission_request')).toBe(false);
  });

  it('returns correct max text length', () => {
    expect(getMaxTextLength('activity_text')).toBe(300);
    expect(getMaxTextLength('permission_request')).toBe(500);
  });
});
