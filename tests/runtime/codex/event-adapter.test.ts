// tests/runtime/codex/event-adapter.test.ts
//
// Fixture-replay tests for CodexEventAdapter. Verifies each forwarded
// JSON-RPC notification translates to the expected NotificationEvent.

import { describe, it, expect } from 'vitest';
import { CodexEventAdapter } from '../../../src/runtime/codex/event-adapter.js';

describe('CodexEventAdapter', () => {
  it('emits turn_start on turn/started', () => {
    const adapter = new CodexEventAdapter();
    const frame = adapter.handle('turn/started', { turn: { id: 'turn-1', userInput: 'hello' } });
    expect(frame.events[0]).toMatchObject({
      kind: 'turn_start', turnId: 'turn-1', userInputPreview: 'hello',
    });
  });

  it('emits turn_end + usage on turn/completed', () => {
    const adapter = new CodexEventAdapter();
    adapter.handle('turn/started', { turn: { id: 'turn-1', userInput: 'hi' } });
    adapter.handle('thread/tokenUsage/updated', {
      tokenUsage: { last: { inputTokens: 10, outputTokens: 20, costUsd: 0.05 } },
    });
    const frame = adapter.handle('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    expect(frame.events[0]).toMatchObject({
      kind: 'turn_end', tokensIn: 10, tokensOut: 20, costUsd: 0.05,
    });
    expect(frame.usage).toMatchObject({ inputTokens: 10, outputTokens: 20, costUsd: 0.05 });
  });

  it('emits runtime_error on failed turn/completed', () => {
    const adapter = new CodexEventAdapter();
    adapter.handle('turn/started', { turn: { id: 'turn-1' } });
    const frame = adapter.handle('turn/completed', {
      turn: { id: 'turn-1', status: 'failed', error: { message: 'oops' } },
    });
    const kinds = frame.events.map((e) => e.kind);
    expect(kinds).toContain('turn_end');
    expect(kinds).toContain('runtime_error');
    const err = frame.events.find((e) => e.kind === 'runtime_error');
    expect(err).toMatchObject({ message: 'oops' });
  });

  it('emits assistant_text on item/completed with agentMessage', () => {
    const adapter = new CodexEventAdapter();
    adapter.handle('turn/started', { turn: { id: 'turn-1' } });
    const frame = adapter.handle('item/completed', {
      item: { id: 'item-1', type: 'agentMessage', text: 'Hello user' },
    });
    expect(frame.events[0]).toMatchObject({
      kind: 'assistant_text', text: 'Hello user', complete: true,
    });
  });

  it('splits reasoning out of <think>...</think> in agentMessage', () => {
    const adapter = new CodexEventAdapter();
    adapter.handle('turn/started', { turn: { id: 'turn-1' } });
    const frame = adapter.handle('item/completed', {
      item: { id: 'item-1', type: 'agentMessage', text: '<think>ponder</think>final answer' },
    });
    const kinds = frame.events.map((e) => e.kind);
    expect(kinds).toContain('thinking_delta');
    expect(kinds).toContain('thinking_end');
    expect(kinds).toContain('assistant_text');
  });

  it('emits tool_use_start on item/started commandExecution', () => {
    const adapter = new CodexEventAdapter();
    adapter.handle('turn/started', { turn: { id: 'turn-1' } });
    const frame = adapter.handle('item/started', {
      item: { id: 'cmd-1', type: 'commandExecution', command: 'ls', cwd: '/tmp' },
    });
    expect(frame.events[0]).toMatchObject({
      kind: 'tool_use_start', toolName: 'Bash', toolUseId: 'cmd-1',
    });
  });

  it('emits tool_use_result on item/completed commandExecution', () => {
    const adapter = new CodexEventAdapter();
    adapter.handle('turn/started', { turn: { id: 'turn-1' } });
    adapter.handle('item/started', {
      item: { id: 'cmd-1', type: 'commandExecution', command: 'ls' },
    });
    const frame = adapter.handle('item/completed', {
      item: { id: 'cmd-1', type: 'commandExecution', status: 'completed', output: 'a\nb' },
    });
    expect(frame.events[0]).toMatchObject({
      kind: 'tool_use_result', toolUseId: 'cmd-1', ok: true, output: 'a\nb',
    });
  });

  it('emits file_changed for each change in fileChange item', () => {
    const adapter = new CodexEventAdapter();
    adapter.handle('turn/started', { turn: { id: 'turn-1' } });
    const frame = adapter.handle('item/completed', {
      item: {
        id: 'fc-1',
        type: 'fileChange',
        changes: [
          { path: '/a.ts', kind: 'add' },
          { path: '/b.ts', kind: 'update' },
        ],
      },
    });
    expect(frame.events).toHaveLength(2);
    expect(frame.events[0]).toMatchObject({ kind: 'file_changed', path: '/a.ts', op: 'created' });
    expect(frame.events[1]).toMatchObject({ kind: 'file_changed', path: '/b.ts', op: 'modified' });
  });

  it('emits assistant_text_delta on item/agentMessage/delta', () => {
    const adapter = new CodexEventAdapter();
    adapter.handle('turn/started', { turn: { id: 'turn-1' } });
    const frame = adapter.handle('item/agentMessage/delta', { delta: 'partial ' });
    expect(frame.events[0]).toMatchObject({ kind: 'assistant_text_delta', text: 'partial ', partial: true });
  });

  it('emits runtime_error on method=error', () => {
    const adapter = new CodexEventAdapter();
    const frame = adapter.handle('error', { message: 'something broke' });
    expect(frame.events[0]).toMatchObject({ kind: 'runtime_error', message: 'something broke' });
  });

  it('no-ops on unknown method', () => {
    const adapter = new CodexEventAdapter();
    const frame = adapter.handle('some/unknown/method', { foo: 'bar' });
    expect(frame.events).toEqual([]);
  });
});
