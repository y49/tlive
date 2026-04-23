// tests/permission/elicitation-broker.test.ts

import { describe, it, expect, vi } from 'vitest';
import { ElicitationBroker } from '../../src/permission/elicitation-broker.js';
import type { ElicitationRequest } from '../../src/runtime/types.js';

function req(
  id: string,
  mode: ElicitationRequest['mode'] = 'form',
  overrides: Partial<ElicitationRequest> = {},
): ElicitationRequest {
  return {
    id,
    mcpServerName: 'test-mcp',
    mode,
    resolve: vi.fn(),
    ...overrides,
  };
}

describe('ElicitationBroker', () => {
  it('form-mode request resolves with content payload', () => {
    const broker = new ElicitationBroker();
    const r = req('s:form', 'form', {
      schema: { name: { type: 'string', required: true } },
      description: 'Please enter your name',
    });
    broker.issue('s', r);
    expect(broker.pendingCount()).toBe(1);
    broker.resolve('s', 's:form', { action: 'accept', content: { name: 'Alice' } });
    expect(r.resolve).toHaveBeenCalledWith({ action: 'accept', content: { name: 'Alice' } });
  });

  it('confirm-mode request resolves with decline', () => {
    const broker = new ElicitationBroker();
    const r = req('s:c', 'confirm', { description: 'Proceed?' });
    broker.issue('s', r);
    broker.resolve('s', 's:c', { action: 'decline' });
    expect(r.resolve).toHaveBeenCalledWith({ action: 'decline' });
  });

  it('url-auth-mode request resolves with accept (auth complete)', () => {
    const broker = new ElicitationBroker();
    const r = req('s:u', 'url-auth', { url: 'https://auth.example.com/consent' });
    broker.issue('s', r);
    broker.resolve('s', 's:u', { action: 'accept' });
    expect(r.resolve).toHaveBeenCalledWith({ action: 'accept' });
  });

  it('denyAllForSession declines every pending', () => {
    const broker = new ElicitationBroker();
    const a = req('s1:a', 'form'); const b = req('s1:b', 'confirm'); const c = req('s2:c', 'url-auth');
    broker.issue('s1', a); broker.issue('s1', b); broker.issue('s2', c);
    broker.denyAllForSession('s1');
    expect(a.resolve).toHaveBeenCalledWith({ action: 'decline' });
    expect(b.resolve).toHaveBeenCalledWith({ action: 'decline' });
    expect(c.resolve).not.toHaveBeenCalled();
  });

  it('resolveById finds across sessions', () => {
    const broker = new ElicitationBroker();
    const r = req('s9:z', 'confirm');
    broker.issue('s9', r);
    expect(broker.resolveById('s9:z', { action: 'accept' })).toBe(true);
  });

  it('duplicate issue throws', () => {
    const broker = new ElicitationBroker();
    broker.issue('s', req('s:a'));
    expect(() => broker.issue('s', req('s:a'))).toThrow(/duplicate/);
  });

  it('pendingFor returns the stored request', () => {
    const broker = new ElicitationBroker();
    const r = req('s:a', 'form');
    broker.issue('s', r);
    expect(broker.pendingFor('s')).toEqual([r]);
  });
});
