// tests/daemon/stale-permission-recovery.test.ts
//
// Smoke-tests the stale-card recovery helper from spec §13.4:
//   - resume success + re-emit → old card edited, status 'resumed_re-emitted'
//   - resume success + no re-emit → old card edited to 'Session restored — awaiting new card…'
//   - resume failure → 'invalidated'

import { describe, it, expect, vi } from 'vitest';
import { recoverStalePermissionCard } from '../../src/daemon/stale-permission-recovery.js';
import type { SessionManager } from '../../src/session/manager.js';
import type { PermissionBroker } from '../../src/permission/broker.js';
import type { PlatformAdapter } from '../../src/platform/types.js';
import type { PermissionRequest } from '../../src/runtime/types.js';

function mockAdapter(): PlatformAdapter {
  return {
    channelType: 'telegram',
    async start() {},
    async stop() {},
    async send() { return 'mid'; },
    edit: vi.fn().mockResolvedValue(undefined),
    async delete() {},
    async pin() {},
    async setReaction() {},
    async sendAttachment() { return 'mid'; },
    async downloadAttachment() { return Buffer.alloc(0); },
    onInbound() { return () => undefined; },
  } as unknown as PlatformAdapter;
}

describe('recoverStalePermissionCard', () => {
  it('returns invalidated when resume fails', async () => {
    const sessions = { async resumeLocal() { return null; } } as unknown as SessionManager;
    const permissionBroker = { pendingFor: () => [] } as unknown as PermissionBroker;
    const adapter = mockAdapter();
    const result = await recoverStalePermissionCard('sid', 'mid', 'chat', 'telegram', {
      sessions, permissionBroker, adapters: { telegram: adapter }, waitMs: 50,
    });
    expect(result.status).toBe('invalidated');
    expect(adapter.edit).toHaveBeenCalled();
  });

  it('returns resumed_re-emitted when a new request appears', async () => {
    const sessions = { async resumeLocal() { return { id: 'sid' }; } } as unknown as SessionManager;
    let returned: PermissionRequest[] = [];
    const permissionBroker = { pendingFor: () => returned } as unknown as PermissionBroker;
    const adapter = mockAdapter();
    setTimeout(() => {
      returned = [{ id: 'sid:req', category: 'exec', toolName: 't' } as unknown as PermissionRequest];
    }, 20);
    const result = await recoverStalePermissionCard('sid', 'mid', 'chat', 'telegram', {
      sessions, permissionBroker, adapters: { telegram: adapter }, waitMs: 200,
    });
    expect(result.status).toBe('resumed_re-emitted');
  });

  it('returns resumed_waiting when nothing re-emits within window', async () => {
    const sessions = { async resumeLocal() { return { id: 'sid' }; } } as unknown as SessionManager;
    const permissionBroker = { pendingFor: () => [] } as unknown as PermissionBroker;
    const adapter = mockAdapter();
    const result = await recoverStalePermissionCard('sid', 'mid', 'chat', 'telegram', {
      sessions, permissionBroker, adapters: { telegram: adapter }, waitMs: 50,
    });
    expect(result.status).toBe('resumed_waiting');
  });
});
