import { describe, it, expectTypeOf } from 'vitest';
import type { NotificationEvent } from '../../src/runtime/events.js';

describe('NotificationEvent union', () => {
  it('discriminates on kind', () => {
    const event: NotificationEvent = { kind: 'turn_start', turnId: 't', userInputPreview: 'hi', at: 0 };
    if (event.kind === 'turn_start') {
      expectTypeOf(event.turnId).toEqualTypeOf<string>();
    }
  });

  it('tool_use_start carries optional batch metadata', () => {
    const event: NotificationEvent = {
      kind: 'tool_use_start',
      turnId: 't',
      toolUseId: 'tu-1',
      toolName: 'Bash',
      input: { command: 'ls' },
      batchId: 'b1',
      batchIndex: 0,
      batchSize: 2,
    };
    expectTypeOf(event).toMatchTypeOf<{ kind: 'tool_use_start' }>();
  });

  it('file_changed carries structured path + op', () => {
    const event: NotificationEvent = {
      kind: 'file_changed',
      path: '/a',
      op: 'created',
    };
    expectTypeOf(event).toMatchTypeOf<{ kind: 'file_changed' }>();
  });

  it('runtime_error carries severity + code', () => {
    const event: NotificationEvent = {
      kind: 'runtime_error',
      severity: 'warn',
      code: 'some_code',
      message: 'boom',
    };
    expectTypeOf(event).toMatchTypeOf<{ kind: 'runtime_error' }>();
  });

  it('session_complete carries reason + summary', () => {
    const event: NotificationEvent = {
      kind: 'session_complete',
      reason: 'normal',
      summary: 'done',
    };
    expectTypeOf(event).toMatchTypeOf<{ kind: 'session_complete' }>();
  });
});
