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
