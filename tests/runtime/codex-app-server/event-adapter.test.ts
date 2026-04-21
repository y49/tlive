import { describe, it, expect } from 'vitest';
import { CodexEventAdapter } from '../../../src/runtime/codex-app-server/event-adapter.js';

describe('CodexEventAdapter', () => {
  it('item/completed with agentMessage → activity_text', () => {
    const adapter = new CodexEventAdapter();
    const frame = adapter.handle('item/completed', {
      item: { id: 'i1', type: 'agentMessage', text: 'hello world' },
    });
    expect(frame.events).toEqual([{ kind: 'activity_text', text: 'hello world' }]);
    expect(frame.usage).toBeUndefined();
  });

  it('item/completed with commandExecution → activity_tool Bash', () => {
    const adapter = new CodexEventAdapter();
    const frame = adapter.handle('item/completed', {
      item: { id: 'i2', type: 'commandExecution', command: 'ls -la', cwd: '/x' },
    });
    expect(frame.events).toHaveLength(1);
    expect(frame.events[0].kind).toBe('activity_tool');
    const ev = frame.events[0] as { kind: 'activity_tool'; toolName: string; toolInput?: string };
    expect(ev.toolName).toBe('Bash');
    expect(JSON.parse(ev.toolInput!)).toEqual({ command: 'ls -la', cwd: '/x' });
  });

  it('turn/completed emits session_complete + usage when tokenUsage was cached', () => {
    const adapter = new CodexEventAdapter();
    adapter.handle('thread/tokenUsage/updated', {
      tokenUsage: { last: { inputTokens: 10, outputTokens: 20 } },
    });
    const frame = adapter.handle('turn/completed', {
      turn: { id: 't', status: 'completed' },
    });
    expect(frame.events).toHaveLength(1);
    expect(frame.events[0].kind).toBe('session_complete');
    expect(frame.usage).toEqual({
      inputTokens: 10, outputTokens: 20, costUsd: 0, durationMs: 0,
    });
  });

  it('turn/completed with status=failed emits session_complete + error', () => {
    const adapter = new CodexEventAdapter();
    const frame = adapter.handle('turn/completed', {
      turn: { id: 't', status: 'failed', error: { message: 'boom' } },
    });
    const kinds = frame.events.map((e) => e.kind);
    expect(kinds).toEqual(['session_complete', 'error']);
    const errorEv = frame.events[1] as { kind: 'error'; message: string };
    expect(errorEv.message).toBe('boom');
  });

  it('unknown method → empty frame', () => {
    const adapter = new CodexEventAdapter();
    const frame = adapter.handle('some/unknown/method', { foo: 'bar' });
    expect(frame.events).toEqual([]);
    expect(frame.usage).toBeUndefined();
  });

  it('error notification → error NotificationEvent', () => {
    const adapter = new CodexEventAdapter();
    const frame = adapter.handle('error', { message: 'oops' });
    expect(frame.events).toEqual([{ kind: 'error', message: 'oops' }]);
  });

  it('fileChange item → file_change_list', () => {
    const adapter = new CodexEventAdapter();
    const frame = adapter.handle('item/completed', {
      item: {
        id: 'i', type: 'fileChange',
        changes: [{ path: '/a.ts', kind: 'update' }, { path: '/b.ts', kind: 'add' }],
        status: 'completed',
      },
    });
    expect(frame.events).toHaveLength(1);
    const ev = frame.events[0] as { kind: 'file_change_list'; changes: Array<{ path: string; kind: string }>; status: string };
    expect(ev.kind).toBe('file_change_list');
    expect(ev.status).toBe('completed');
    expect(ev.changes).toEqual([
      { path: '/a.ts', kind: 'update' }, { path: '/b.ts', kind: 'add' },
    ]);
  });
});
