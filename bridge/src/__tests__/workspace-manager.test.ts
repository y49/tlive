import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
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

describe('WorkspaceManager persistence', () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'ws-persist-'));
  const persistPath = join(persistDir, 'workspaces.json');
  const dir1 = mkdtempSync(join(tmpdir(), 'wsp-'));

  afterEach(() => {
    if (existsSync(persistPath)) unlinkSync(persistPath);
  });

  it('persists workspaces to disk', () => {
    const mgr = new WorkspaceManager({ persistPath, workdirWhitelist: undefined });
    mgr.openByPath(dir1, { chatId: 'c1', runtime: 'codex' });
    mgr.persist();
    expect(existsSync(persistPath)).toBe(true);
    const raw = JSON.parse(readFileSync(persistPath, 'utf-8'));
    expect(raw.workspaces).toHaveLength(1);
    expect(raw.workspaces[0].workdir).toBe(dir1);
  });

  it('restores workspaces from disk on load', () => {
    writeFileSync(persistPath, JSON.stringify({
      workspaces: [{ name: 'restored', workdir: dir1, runtime: 'codex', chatId: 'c1' }],
    }));
    const mgr = new WorkspaceManager({ persistPath, workdirWhitelist: undefined });
    mgr.load();
    expect(mgr.findByName('restored')?.workdir).toBe(dir1);
  });

  it('handles corrupt persist file without crashing', () => {
    writeFileSync(persistPath, '{{{ not json');
    const mgr = new WorkspaceManager({ persistPath, workdirWhitelist: undefined });
    expect(() => mgr.load()).not.toThrow();
    expect(mgr.list()).toHaveLength(0);
  });
});
