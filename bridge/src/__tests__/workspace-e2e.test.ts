import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceManager } from '../engine/workspace-manager.js';

describe('Workspace E2E', () => {
  it('open → persist → restart → restore', () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'wse2e-'));
    const persistPath = join(persistDir, 'workspaces.json');
    const workdir = mkdtempSync(join(tmpdir(), 'wse2e-workdir-'));

    const mgr1 = new WorkspaceManager({ persistPath, workdirWhitelist: undefined });
    mgr1.load();
    const result = mgr1.openByPath(workdir, { chatId: 'c1', runtime: 'codex' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    mgr1.update(result.workspace.name, {
      threadId: 'thread-xyz',
      perm: 'on',
      model: 'opus',
      activeSessionId: 'sess-1',
    });
    mgr1.persist();

    const mgr2 = new WorkspaceManager({ persistPath, workdirWhitelist: undefined });
    mgr2.load();
    const ws = mgr2.findByWorkdir(workdir);
    expect(ws).toBeDefined();
    expect(ws!.threadId).toBe('thread-xyz');
    expect(ws!.perm).toBe('on');
    expect(ws!.model).toBe('opus');
    expect(ws!.activeSessionId).toBeUndefined();
  });
});

describe('WorkspaceManager — default workspace lifecycle', () => {
  it('auto-registers, lazy-binds, persists, and restores across restart', () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'wsdefault-'));
    const persistPath = join(persistDir, 'workspaces.json');
    const cwd = mkdtempSync(join(tmpdir(), 'wscwd-'));

    // Session 1: fresh start — ensureDefault creates, lazyBindDefault binds
    const mgr1 = new WorkspaceManager({ persistPath, workdirWhitelist: undefined });
    mgr1.load(); // empty file
    const auto = mgr1.ensureDefault({ workdir: cwd, runtime: 'claude' });
    expect(auto).not.toBeNull();
    expect(mgr1.list()).toHaveLength(1);

    const bound = mgr1.lazyBindDefault('chat-abc', undefined);
    expect(bound).toBeDefined();
    expect(bound!.chatId).toBe('chat-abc');
    mgr1.persist();

    // Verify getDefault now returns undefined (bound)
    expect(mgr1.getDefault()).toBeUndefined();

    // Session 2: restart — load from disk
    const mgr2 = new WorkspaceManager({ persistPath, workdirWhitelist: undefined });
    mgr2.load();
    expect(mgr2.list()).toHaveLength(1);

    // Critical: the restored workspace keeps its chatId binding
    const restored = mgr2.findByName(auto!.name);
    expect(restored).toBeDefined();
    expect(restored!.chatId).toBe('chat-abc');
    expect(restored!.workdir).toBe(cwd);

    // ensureDefault on session 2 is a no-op (path match)
    const again = mgr2.ensureDefault({ workdir: cwd, runtime: 'claude' });
    expect(again).not.toBeNull();
    expect(again!.name).toBe(auto!.name); // same entry
    expect(mgr2.list()).toHaveLength(1);

    // lazyBindDefault is a no-op because default is already bound (chatId set)
    expect(mgr2.lazyBindDefault('chat-xyz', undefined)).toBeUndefined();
  });
});
