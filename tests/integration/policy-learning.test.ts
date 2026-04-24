// tests/integration/policy-learning.test.ts
//
// "Learn" flow: operator clicks Learn on a permission card → PolicyStore.add
// persists the rule → next matching permission auto-resolves without
// bothering the operator.
//
// Uses the real PermissionBroker + PolicyStore and a per-workspace resolver
// (mirroring the daemon wire-up in T9). Asserts the broker returns `false`
// from `issue()` on the second call (policy auto-resolve path), not the
// `pending` path.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PermissionBroker, type BrokerEvent } from '../../src/permission/broker.js';
import { PolicyStore } from '../../src/permission/policy-store.js';
import type { PermissionRequest } from '../../src/runtime/types.js';

function makeReq(
  sessionId: string,
  shortId: string,
  toolName: string,
  toolInput: Record<string, unknown> = {},
): { req: PermissionRequest; resolved: { decision?: 'allow' | 'deny' | 'allow_always' } } {
  const resolved: { decision?: 'allow' | 'deny' | 'allow_always' } = {};
  const req: PermissionRequest = {
    id: `${sessionId}:${shortId}`,
    category: 'exec',
    toolName,
    toolInput,
    resolve: (d) => { resolved.decision = d as 'allow' | 'deny' | 'allow_always'; },
  };
  return { req, resolved };
}

describe('integration: policy-learning', () => {
  let root: string;
  let store: PolicyStore;
  let broker: PermissionBroker;
  const WS = 'ws-policy';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tlive-policy-int-'));
    store = new PolicyStore(WS, { file: join(root, 'policies.json') });
    await store.load();
    broker = new PermissionBroker({
      policyStoreFor: (id) => id === WS ? store : undefined,
    });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('first request waits on operator; after Learn the second auto-resolves', async () => {
    const events: BrokerEvent[] = [];
    broker.subscribe((ev) => events.push(ev));

    // --- First request: no matching policy, goes to 'pending' ---
    const first = makeReq('sess-A', 'p1', 'Bash', { command: 'npm test' });
    const pending1 = broker.issue('sess-A', WS, first.req);
    expect(pending1).toBe(true);
    expect(events.at(-1)?.kind).toBe('pending');

    // Operator clicks "Allow + Learn" in IM.
    // Step 1: persist the policy rule (CallbackRouter → PolicyStore.add).
    const rule = await store.add({ toolName: 'Bash', inputMatch: { command: 'npm *' } }, 'allow', 'workspace', 'alice');
    expect(rule.decision).toBe('allow');

    // Step 2: resolve the current pending request (mimics the click).
    expect(broker.resolve('sess-A', first.req.id, 'allow', 'alice')).toBe(true);
    expect(first.resolved.decision).toBe('allow');
    expect(events.at(-1)?.kind).toBe('resolved');

    // --- Second request (same workspace, matching pattern): auto-resolve ---
    const second = makeReq('sess-A', 'p2', 'Bash', { command: 'npm run lint' });
    events.length = 0;
    const pending2 = broker.issue('sess-A', WS, second.req);
    expect(pending2).toBe(false);
    expect(second.resolved.decision).toBe('allow');
    // Exactly one 'resolved' event emitted; no 'pending' fired.
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(['resolved']);
    const resolvedEv = events[0] as Extract<BrokerEvent, { kind: 'resolved' }>;
    expect(resolvedEv.autoResolvedBy).toBe(rule.id);

    // --- Disjoint command: NOT matched by the policy, falls back to pending ---
    const third = makeReq('sess-A', 'p3', 'Bash', { command: 'rm -rf /' });
    events.length = 0;
    const pending3 = broker.issue('sess-A', WS, third.req);
    expect(pending3).toBe(true);
    expect(events.map((e) => e.kind)).toEqual(['pending']);

    // --- Persistence: a fresh PolicyStore loads the rule from disk ---
    const reloaded = new PolicyStore(WS, { file: join(root, 'policies.json') });
    await reloaded.load();
    expect(reloaded.list().map((r) => r.id)).toContain(rule.id);
  });
});
