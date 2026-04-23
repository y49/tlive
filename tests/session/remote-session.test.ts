// tests/session/remote-session.test.ts

import { describe, it, expect, vi } from 'vitest';
import { RemoteSession } from '../../src/session/remote-session.js';
import type { NotificationEvent } from '../../src/runtime/events.js';

function mkSession() {
  return new RemoteSession({
    sdkSessionId: 'abcdef12-0000-1111-2222-333333333333',
    workspaceId: 'ws-remote',
    workdir: '/remote',
    provider: 'claude',
  });
}

describe('RemoteSession', () => {
  it('kind is "remote"; shortAlias has r- prefix', () => {
    const s = mkSession();
    expect(s.kind).toBe('remote');
    expect(s.shortAlias).toBe('r-abcdef12');
  });

  it('setStatus(thinking) emits status_change + event', () => {
    const s = mkSession();
    const events: NotificationEvent[] = [];
    s.onEvent((e) => events.push(e));
    s.setStatus('thinking', { currentTool: 'Read' });
    expect(s.status.phase).toBe('thinking');
    if (s.status.phase === 'thinking') expect(s.status.currentTool).toBe('Read');
    expect(events.some((e) => e.kind === 'status_change')).toBe(true);
  });

  it('addPendingPermission exposes it and fires permission_requested', () => {
    const s = mkSession();
    const events: NotificationEvent[] = [];
    s.onEvent((e) => events.push(e));
    const resolve = vi.fn();
    s.addPendingPermission({
      id: 'req-1', category: 'exec', toolName: 'Bash', toolInput: { cmd: 'ls' },
      resolve,
    });
    expect(s.listPendingPermissions()).toHaveLength(1);
    expect(events.some((e) => e.kind === 'permission_requested')).toBe(true);
  });

  it('resolvePendingPermission fires resolve callback + emits resolved event', () => {
    const s = mkSession();
    const resolve = vi.fn();
    s.addPendingPermission({
      id: 'req-1', category: 'exec', toolName: 'Bash', toolInput: {}, resolve,
    });
    const ok = s.resolvePendingPermission('req-1', 'allow');
    expect(ok).toBe(true);
    expect(resolve).toHaveBeenCalledWith('allow');
    expect(s.listPendingPermissions()).toHaveLength(0);
  });

  it('onDisconnect denies pending permissions and transitions to stopped', () => {
    const s = mkSession();
    const resolve = vi.fn();
    s.addPendingPermission({
      id: 'req-1', category: 'exec', toolName: 'Bash', toolInput: {}, resolve,
    });
    s.onDisconnect('disconnect');
    expect(resolve).toHaveBeenCalledWith('deny');
    expect(s.status.phase).toBe('stopped');
    expect(s.isReady).toBe(false);
  });

  it('addPendingAsk and resolvePendingAsk round-trip', () => {
    const s = mkSession();
    const resolve = vi.fn();
    s.addPendingAsk({ id: 'ask-1', prompt: 'pick', options: ['a', 'b'], resolve });
    expect(s.listPendingAsks()).toHaveLength(1);
    s.resolvePendingAsk('ask-1', ['a']);
    expect(resolve).toHaveBeenCalledWith(['a']);
  });

  it('sendInput throws (not supported by daemon for remotes)', async () => {
    const s = mkSession();
    await expect(s.sendInput('hi')).rejects.toThrow(/RemoteSession/);
  });

  it('recordAttachment emits attachment_produced event', () => {
    const s = mkSession();
    const events: NotificationEvent[] = [];
    s.onEvent((e) => events.push(e));
    s.recordAttachment({
      attachmentId: 'att-1', name: 'file.txt', mime: 'text/plain', sizeBytes: 10, path: '/tmp/file.txt',
    });
    expect(events.some((e) => e.kind === 'attachment_produced')).toBe(true);
  });
});
