// tests/permission/ask-broker.test.ts

import { describe, it, expect, vi } from 'vitest';
import { AskUserQuestionBroker } from '../../src/permission/ask-broker.js';
import type { AskUserQuestionRequest } from '../../src/runtime/types.js';

function req(id: string, overrides: Partial<AskUserQuestionRequest> = {}): AskUserQuestionRequest {
  return {
    id,
    prompt: 'Pick one',
    options: ['a', 'b', 'c'],
    resolve: vi.fn(),
    ...overrides,
  };
}

describe('AskUserQuestionBroker', () => {
  it('issue / resolve / pendingFor lifecycle', () => {
    const broker = new AskUserQuestionBroker();
    const r = req('s1:q');
    broker.issue('s1', r);
    expect(broker.pendingFor('s1')).toHaveLength(1);
    expect(broker.pendingCount()).toBe(1);
    const ok = broker.resolve('s1', 's1:q', ['a']);
    expect(ok).toBe(true);
    expect(r.resolve).toHaveBeenCalledWith(['a']);
    expect(broker.pendingCount()).toBe(0);
  });

  it('resolve returns false for unknown id', () => {
    const broker = new AskUserQuestionBroker();
    expect(broker.resolve('s', 'nope', [])).toBe(false);
  });

  it('resolveById cross-session lookup', () => {
    const broker = new AskUserQuestionBroker();
    const r = req('sX:q7');
    broker.issue('sX', r);
    expect(broker.resolveById('sX:q7', ['b'], 'userA')).toBe(true);
    expect(r.resolve).toHaveBeenCalledWith(['b']);
  });

  it('denyAllForSession resolves with empty array (decline semantic)', () => {
    const broker = new AskUserQuestionBroker();
    const a = req('s1:a'); const b = req('s2:b');
    broker.issue('s1', a); broker.issue('s2', b);
    broker.denyAllForSession('s1');
    expect(a.resolve).toHaveBeenCalledWith([]);
    expect(b.resolve).not.toHaveBeenCalled();
  });

  it('subscribe fires pending + resolved with chosen payload', () => {
    const broker = new AskUserQuestionBroker();
    const events: any[] = [];
    broker.subscribe((e) => events.push(e));
    const r = req('s:q', { multiSelect: true });
    broker.issue('s', r);
    broker.resolve('s', 's:q', ['a', 'c'], 'user-1');
    expect(events.map((e) => e.kind)).toEqual(['pending', 'resolved']);
    expect(events[1]).toMatchObject({
      requestId: 's:q', chosen: ['a', 'c'], resolvedByUserId: 'user-1',
    });
  });

  it('duplicate id throws', () => {
    const broker = new AskUserQuestionBroker();
    broker.issue('s', req('s:q'));
    expect(() => broker.issue('s', req('s:q'))).toThrow(/duplicate/);
  });
});
