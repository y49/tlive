import { describe, it, expectTypeOf } from 'vitest';
import type { NotificationEvent } from '../../src/runtime/events.js';

describe('NotificationEvent union', () => {
  it('discriminates on kind', () => {
    const event: NotificationEvent = { kind: 'thinking', active: true };
    if (event.kind === 'thinking') {
      expectTypeOf(event.active).toEqualTypeOf<boolean>();
    }
  });

  it('activity_tool carries optional terminalUrl', () => {
    const event: NotificationEvent = { kind: 'activity_tool', toolName: 'Bash', terminalUrl: 'http://x/' };
    expectTypeOf(event).toMatchTypeOf<{ kind: 'activity_tool' }>();
  });

  it('file_change_list carries status + changes', () => {
    const event: NotificationEvent = {
      kind: 'file_change_list',
      changes: [{ path: '/a', kind: 'add' }],
      status: 'completed',
    };
    expectTypeOf(event).toMatchTypeOf<{ kind: 'file_change_list' }>();
  });
});
