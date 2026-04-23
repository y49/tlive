// tests/permission/broker.test.ts

import { describe, it, expect, vi } from 'vitest';
import { PermissionBroker } from '../../src/permission/broker.js';
import type { PermissionRequest } from '../../src/runtime/types.js';
import { PolicyStore } from '../../src/permission/policy-store.js';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

function req(id: string, overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id,
    category: 'generic',
    toolName: 'Bash',
    toolInput: {},
    resolve: vi.fn(),
    ...overrides,
  };
}

describe('PermissionBroker', () => {
  it('issue stores request and emits pending', () => {
    const broker = new PermissionBroker();
    const events: any[] = [];
    broker.subscribe((e) => events.push(e));
    const r = req('s1:a');
    broker.issue('s1', undefined, r);
    expect(broker.pendingFor('s1')).toHaveLength(1);
    expect(broker.pendingCount()).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'pending', sessionId: 's1' });
    expect(events[0].request.id).toBe('s1:a');
  });

  it('resolve invokes req.resolve and emits resolved', () => {
    const broker = new PermissionBroker();
    const r = req('s1:a');
    broker.issue('s1', undefined, r);
    const events: any[] = [];
    broker.subscribe((e) => events.push(e));
    const ok = broker.resolve('s1', 's1:a', 'allow', 'user-7');
    expect(ok).toBe(true);
    expect(r.resolve).toHaveBeenCalledWith('allow');
    expect(broker.pendingCount()).toBe(0);
    expect(events[0]).toMatchObject({
      kind: 'resolved', sessionId: 's1', requestId: 's1:a',
      decision: 'allow', resolvedByUserId: 'user-7',
    });
  });

  it('resolve returns false for unknown id', () => {
    const broker = new PermissionBroker();
    expect(broker.resolve('s1', 'nope', 'allow')).toBe(false);
  });

  it('resolve returns false when requestId is on a different session', () => {
    const broker = new PermissionBroker();
    broker.issue('s1', undefined, req('s1:a'));
    expect(broker.resolve('s2', 's1:a', 'allow')).toBe(false);
    // Still pending on its real owner.
    expect(broker.pendingFor('s1')).toHaveLength(1);
  });

  it('resolveById finds the owning session and resolves', () => {
    const broker = new PermissionBroker();
    const r = req('s7:z');
    broker.issue('s7', undefined, r);
    const ok = broker.resolveById('s7:z', 'deny');
    expect(ok).toBe(true);
    expect(r.resolve).toHaveBeenCalledWith('deny');
  });

  it('denyAllForSession denies only that session', () => {
    const broker = new PermissionBroker();
    const a = req('s1:a'); const b = req('s1:b'); const c = req('s2:c');
    broker.issue('s1', undefined, a);
    broker.issue('s1', undefined, b);
    broker.issue('s2', undefined, c);
    broker.denyAllForSession('s1');
    expect(a.resolve).toHaveBeenCalledWith('deny');
    expect(b.resolve).toHaveBeenCalledWith('deny');
    expect(c.resolve).not.toHaveBeenCalled();
    expect(broker.pendingCount()).toBe(1);
  });

  it('subscribe fan-out: late listeners do not receive past events', () => {
    const broker = new PermissionBroker();
    broker.issue('s1', undefined, req('s1:a'));
    const events: any[] = [];
    broker.subscribe((e) => events.push(e));
    // Nothing replayed.
    expect(events).toHaveLength(0);
    broker.resolve('s1', 's1:a', 'allow');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('resolved');
  });

  it('unsubscribe stops delivery', () => {
    const broker = new PermissionBroker();
    const listener = vi.fn();
    const unsub = broker.subscribe(listener);
    broker.issue('s1', undefined, req('s1:a'));
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    broker.issue('s1', undefined, req('s1:b'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('duplicate issue on same id throws', () => {
    const broker = new PermissionBroker();
    broker.issue('s1', undefined, req('s1:a'));
    expect(() => broker.issue('s1', undefined, req('s1:a'))).toThrow(/duplicate/);
  });

  it('PermissionRequest carries 4 categories through broker', () => {
    const broker = new PermissionBroker();
    const captured: any[] = [];
    broker.subscribe((e) => { if (e.kind === 'pending') captured.push(e.request.category); });
    for (const category of ['exec', 'file-edit', 'generic', 'elicitation'] as const) {
      broker.issue('s', undefined, req(`s:${category}`, { category }));
    }
    expect(captured).toEqual(['exec', 'file-edit', 'generic', 'elicitation']);
  });

  it('policy match auto-resolves before broadcasting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tlive-broker-policy-'));
    try {
      const store = new PolicyStore('ws-1', { file: join(root, 'policies.json') });
      await store.add({ toolName: 'Read' }, 'allow', 'workspace', 'user');
      const broker = new PermissionBroker({ policyStoreFor: (id) => id === 'ws-1' ? store : undefined });
      const events: any[] = [];
      broker.subscribe((e) => events.push(e));
      const r = req('s1:a', { toolName: 'Read' });
      broker.issue('s1', 'ws-1', r);
      // Should NOT be stored — auto-resolved instead.
      expect(broker.pendingCount()).toBe(0);
      expect(r.resolve).toHaveBeenCalledWith('allow');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'resolved', sessionId: 's1', decision: 'allow',
      });
      expect(events[0].autoResolvedBy).toMatch(/^pol-/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('policy miss falls through to normal issue flow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tlive-broker-policy-miss-'));
    try {
      const store = new PolicyStore('ws-1', { file: join(root, 'policies.json') });
      await store.add({ toolName: 'Write' }, 'allow', 'workspace', 'user');
      const broker = new PermissionBroker({ policyStoreFor: () => store });
      const r = req('s1:a', { toolName: 'Read' });
      broker.issue('s1', 'ws-1', r);
      expect(broker.pendingCount()).toBe(1);
      expect(r.resolve).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('policy resolver failure is swallowed (falls through to pending)', () => {
    const broker = new PermissionBroker({
      policyStoreFor: () => ({ match: () => { throw new Error('boom'); } } as any),
    });
    const r = req('s1:a');
    expect(() => broker.issue('s1', 'ws-1', r)).not.toThrow();
    expect(broker.pendingCount()).toBe(1);
  });

  it('pendingFor returns empty array for unknown session', () => {
    const broker = new PermissionBroker();
    expect(broker.pendingFor('nope')).toEqual([]);
  });
});
