import { describe, it, expect, vi } from 'vitest';
import { PermissionBroker } from '../../src/session/permission-broker.js';

describe('PermissionBroker', () => {
  it('waitFor resolves when resolve() is called, and fires runtimeResolve', async () => {
    const broker = new PermissionBroker();
    const runtime = vi.fn();
    const { request, completion } = broker.waitFor('s1', 'tu1', 'Bash', { cmd: 'ls' }, runtime);
    expect(request.id).toBe('s1:tu1');
    expect(broker.pendingCount()).toBe(1);
    broker.resolve('s1:tu1', 'allow');
    await expect(completion).resolves.toBe('allow');
    expect(runtime).toHaveBeenCalledWith('allow');
    expect(broker.pendingCount()).toBe(0);
  });

  it('listForSession returns only matching requests', async () => {
    const broker = new PermissionBroker();
    broker.waitFor('s1', 'a', 'Bash', {}, () => {});
    broker.waitFor('s2', 'b', 'Read', {}, () => {});
    broker.waitFor('s1', 'c', 'Write', {}, () => {});
    expect(broker.listForSession('s1').map((r) => r.id)).toEqual(['s1:a', 's1:c']);
    expect(broker.listForSession('s2').map((r) => r.id)).toEqual(['s2:b']);
  });

  it('denyAllForSession resolves only that session', async () => {
    const broker = new PermissionBroker();
    const r1 = vi.fn(); const r2 = vi.fn();
    const { completion: p1 } = broker.waitFor('s1', 'a', 'Bash', {}, r1);
    const { completion: p2 } = broker.waitFor('s2', 'b', 'Read', {}, r2);
    broker.denyAllForSession('s1');
    await expect(p1).resolves.toBe('deny');
    expect(r1).toHaveBeenCalledWith('deny');
    expect(r2).not.toHaveBeenCalled();
    expect(broker.pendingCount()).toBe(1);
    broker.resolve('s2:b', 'allow');
    await expect(p2).resolves.toBe('allow');
  });

  it('request.resolve() on the PermissionRequest object is equivalent to broker.resolve(id, ...)', async () => {
    const broker = new PermissionBroker();
    const runtime = vi.fn();
    const { request, completion } = broker.waitFor('s1', 't', 'Bash', {}, runtime);
    request.resolve('allow_always');
    await expect(completion).resolves.toBe('allow_always');
    expect(runtime).toHaveBeenCalledWith('allow_always');
  });

  it('resolve() on unknown id returns false and does not throw', () => {
    const broker = new PermissionBroker();
    expect(broker.resolve('nope', 'allow')).toBe(false);
  });

  it('duplicate waitFor on same id throws', () => {
    const broker = new PermissionBroker();
    broker.waitFor('s1', 't', 'X', {}, () => {});
    expect(() => broker.waitFor('s1', 't', 'X', {}, () => {})).toThrow(/duplicate/);
  });

  it('subscribe receives pending + resolved events', async () => {
    const broker = new PermissionBroker();
    const events: any[] = [];
    broker.subscribe((ev) => events.push(ev));
    broker.waitFor('s1', 't', 'Bash', {}, () => {});
    broker.resolve('s1:t', 'deny');
    expect(events.map((e) => e.kind)).toEqual(['pending', 'resolved']);
    expect(events[1]).toMatchObject({ id: 's1:t', decision: 'deny', sessionId: 's1' });
  });
});
