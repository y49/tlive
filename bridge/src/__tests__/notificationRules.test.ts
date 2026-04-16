import { describe, it, expect } from 'vitest';
import { shouldPushAtLevel, type NotificationKind } from '../im/notificationRules.js';

describe('shouldPushAtLevel', () => {
  const quietKinds: NotificationKind[] = [
    'permission_request', 'ask_user_question', 'session_complete', 'error', 'todo_update',
  ];
  const normalOnlyKinds: NotificationKind[] = [
    'reasoning_summary', 'file_change_list', 'activity_text',
  ];
  const fullOnlyKinds: NotificationKind[] = [
    'activity_tool', 'thinking',
  ];

  it('level 0 pushes only quiet-tier kinds', () => {
    for (const k of quietKinds) expect(shouldPushAtLevel(k, 0)).toBe(true);
    for (const k of normalOnlyKinds) expect(shouldPushAtLevel(k, 0)).toBe(false);
    for (const k of fullOnlyKinds) expect(shouldPushAtLevel(k, 0)).toBe(false);
  });

  it('level 1 adds normal tier', () => {
    for (const k of quietKinds) expect(shouldPushAtLevel(k, 1)).toBe(true);
    for (const k of normalOnlyKinds) expect(shouldPushAtLevel(k, 1)).toBe(true);
    for (const k of fullOnlyKinds) expect(shouldPushAtLevel(k, 1)).toBe(false);
  });

  it('level 2 pushes everything', () => {
    for (const k of [...quietKinds, ...normalOnlyKinds, ...fullOnlyKinds]) {
      expect(shouldPushAtLevel(k, 2)).toBe(true);
    }
  });
});
