import { describe, it, expect } from 'vitest';
import { mapCanonicalToNotifications, MAX_REASONING_CHARS } from '../engine/sdk-engine.js';
import type { CanonicalEvent } from '../messages/schema.js';

describe('mapCanonicalToNotifications', () => {
  it('maps reasoning_complete to reasoning_summary', () => {
    const ce: CanonicalEvent = { kind: 'reasoning_complete', text: 'ponder', durationMs: 1000 };
    const notifs = mapCanonicalToNotifications([ce]);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].kind).toBe('reasoning_summary');
    expect((notifs[0] as any).text).toBe('ponder');
    expect((notifs[0] as any).durationMs).toBe(1000);
  });

  it('truncates reasoning over MAX_REASONING_CHARS', () => {
    const long = 'x'.repeat(MAX_REASONING_CHARS + 500);
    const ce: CanonicalEvent = { kind: 'reasoning_complete', text: long };
    const notifs = mapCanonicalToNotifications([ce]);
    const n = notifs[0] as any;
    expect(n.text.length).toBe(MAX_REASONING_CHARS);
    expect(n.truncated).toBe(true);
  });

  it('maps file_change_list to file_change_list', () => {
    const ce: CanonicalEvent = {
      kind: 'file_change_list',
      changes: [{ path: 'a.ts', kind: 'add' }],
      status: 'completed',
    };
    const notifs = mapCanonicalToNotifications([ce]);
    expect(notifs[0].kind).toBe('file_change_list');
  });

  it('maps todo_list_update to todo_update', () => {
    const ce: CanonicalEvent = {
      kind: 'todo_list_update',
      items: [{ text: 'do x', completed: false }],
    };
    const notifs = mapCanonicalToNotifications([ce]);
    expect(notifs[0].kind).toBe('todo_update');
  });
});
