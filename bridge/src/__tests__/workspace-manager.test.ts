import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceManager } from '../engine/workspace-manager.js';

describe('WorkspaceManager create/lookup', () => {
  let dir1: string;
  let dir2: string;
  let mgr: WorkspaceManager;

  beforeEach(() => {
    dir1 = mkdtempSync(join(tmpdir(), 'ws1-'));
    dir2 = mkdtempSync(join(tmpdir(), 'ws2-'));
    mgr = new WorkspaceManager({ persistPath: null, workdirWhitelist: undefined });
  });

  it('creates a new workspace from /open path with inferred name', () => {
    const ws = mgr.openByPath(dir1, { chatId: 'c1', runtime: 'codex' });
    expect(ws.ok).toBe(true);
    if (!ws.ok) return;
    expect(ws.workspace.workdir).toBe(dir1);
    expect(ws.workspace.name).toBe(dir1.split('/').pop());
    expect(ws.workspace.runtime).toBe('codex');
    expect(ws.workspace.chatId).toBe('c1');
  });

  it('returns the same workspace when opened twice by path', () => {
    const a = mgr.openByPath(dir1, { chatId: 'c1', runtime: 'codex' });
    const b = mgr.openByPath(dir1, { chatId: 'c1', runtime: 'codex' });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.workspace.name).toBe(b.workspace.name);
  });

  it('looks up workspace by name', () => {
    mgr.openByPath(dir1, { chatId: 'c1', runtime: 'codex' });
    const found = mgr.findByName('' + dir1.split('/').pop());
    expect(found?.workdir).toBe(dir1);
  });

  it('looks up workspace by workdir', () => {
    mgr.openByPath(dir1, { chatId: 'c1', runtime: 'codex' });
    const found = mgr.findByWorkdir(dir1);
    expect(found?.name).toBe(dir1.split('/').pop());
  });

  it('registers pre-configured workspace (no channel open yet)', () => {
    mgr.register({ name: 'alpha', workdir: dir1, runtime: 'codex' });
    const found = mgr.findByName('alpha');
    expect(found?.chatId).toBeUndefined();
    expect(found?.workdir).toBe(dir1);
  });

  it('opens a pre-registered workspace and attaches chatId', () => {
    mgr.register({ name: 'alpha', workdir: dir1, runtime: 'codex' });
    const result = mgr.openByName('alpha', { chatId: 'c1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.chatId).toBe('c1');
  });

  it('rejects /open on invalid workdir', () => {
    const result = mgr.openByPath('/totally/not/a/path', { chatId: 'c1', runtime: 'codex' });
    expect(result.ok).toBe(false);
  });

  it('lists all workspaces', () => {
    mgr.openByPath(dir1, { chatId: 'c1', runtime: 'codex' });
    mgr.openByPath(dir2, { chatId: 'c1', runtime: 'codex' });
    expect(mgr.list()).toHaveLength(2);
  });
});
