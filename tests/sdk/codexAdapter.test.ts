import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { CodexAdapter } from '../../src/sdk/codexAdapter.js';

describe('CodexAdapter', () => {
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
  });

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
  });

  it('name is codex', () => {
    expect(new CodexAdapter().name).toBe('codex');
  });

  it('getSessionDir honors CODEX_HOME', () => {
    process.env.CODEX_HOME = '/tmp/my-codex';
    expect(new CodexAdapter().getSessionDir('/any')).toBe(
      join('/tmp/my-codex', 'sessions'),
    );
  });

  it('getSessionIdArgs returns empty (scanner matches session)', () => {
    expect(new CodexAdapter().getSessionIdArgs('sid')).toEqual([]);
  });

  it('getResumeArgs returns --resume <sessionId>', () => {
    expect(new CodexAdapter().getResumeArgs('sid-1')).toEqual([
      '--resume',
      'sid-1',
    ]);
  });

  it('spawnArgs forwards opts.args (or empty)', () => {
    const a = new CodexAdapter();
    expect(a.spawnArgs({ sessionId: 's', cwd: '/x' })).toEqual([]);
    expect(
      a.spawnArgs({ sessionId: 's', cwd: '/x', args: ['--foo', 'bar'] }),
    ).toEqual(['--foo', 'bar']);
  });
});

describe('CodexAdapter.normalizeSessionEvent (scanner path)', () => {
  const adapter = new CodexAdapter();

  it('maps response_item.message (role=assistant) to NormalizedMessage.text', () => {
    const event = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello' }],
      },
    };
    const out = adapter.normalizeSessionEvent!(event, { sessionId: 's1' });
    expect(out[0]).toMatchObject({ kind: 'text', text: 'Hello', provider: 'codex', sessionId: 's1' });
  });

  it('skips response_item.message where role is not assistant', () => {
    const event = {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    };
    const out = adapter.normalizeSessionEvent!(event);
    expect(out).toEqual([]);
  });

  it('maps response_item.function_call to NormalizedMessage.tool_use', () => {
    const event = {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: '{"cmd":"ls"}',
        call_id: 'call_1',
      },
    };
    const out = adapter.normalizeSessionEvent!(event, { sessionId: 's1' });
    expect(out[0]).toMatchObject({ kind: 'tool_use', toolName: 'exec_command', toolUseId: 'call_1' });
  });

  it('maps response_item.function_call_output to NormalizedMessage.tool_result', () => {
    const event = {
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    };
    const out = adapter.normalizeSessionEvent!(event, { sessionId: 's1' });
    expect(out[0]).toMatchObject({ kind: 'tool_result', toolUseId: 'call_1' });
  });

  it('skips response_item.reasoning (encrypted; no content to emit)', () => {
    const event = {
      type: 'response_item',
      payload: { type: 'reasoning', summary: [], content: null, encrypted_content: 'xxx' },
    };
    const out = adapter.normalizeSessionEvent!(event);
    expect(out).toEqual([]);
  });

  it('skips session_meta / turn_context', () => {
    expect(adapter.normalizeSessionEvent!({ type: 'session_meta', payload: {} })).toEqual([]);
    expect(adapter.normalizeSessionEvent!({ type: 'turn_context', payload: {} })).toEqual([]);
  });

  it('returns [] for unknown top-level type', () => {
    expect(adapter.normalizeSessionEvent!({ type: 'wat', payload: {} })).toEqual([]);
  });
});

describe('CodexAdapter.extractThinkingEvents', () => {
  const adapter = new CodexAdapter();

  it('emits tool_use on event_msg.task_started', () => {
    const out = adapter.extractThinkingEvents!({ type: 'event_msg', payload: { type: 'task_started' } });
    expect(out).toEqual([{ type: 'tool_use', toolUseId: '__codex_task__' }]);
  });

  it('emits tool_result on event_msg.task_complete', () => {
    const out = adapter.extractThinkingEvents!({ type: 'event_msg', payload: { type: 'task_complete' } });
    expect(out).toEqual([{ type: 'tool_result', toolUseId: '__codex_task__' }]);
  });

  it('emits tool_use on response_item.reasoning (encrypted status-only)', () => {
    const out = adapter.extractThinkingEvents!({ type: 'response_item', payload: { type: 'reasoning' } });
    expect(out).toEqual([{ type: 'tool_use', toolUseId: '__codex_reasoning__' }]);
  });

  it('returns [] for unrelated events', () => {
    expect(adapter.extractThinkingEvents!({ type: 'response_item', payload: { type: 'message' } })).toEqual([]);
  });
});
