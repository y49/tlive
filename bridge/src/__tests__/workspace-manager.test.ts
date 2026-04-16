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

describe('WorkspaceManager.ensureDefault', () => {
  let dir1: string;
  let dir2: string;
  let mgr: WorkspaceManager;

  beforeEach(() => {
    dir1 = mkdtempSync(join(tmpdir(), 'ensure1-'));
    dir2 = mkdtempSync(join(tmpdir(), 'ensure2-'));
    mgr = new WorkspaceManager({ persistPath: null, workdirWhitelist: undefined });
  });

  it('creates a default workspace from basename when manager is empty', () => {
    const ws = mgr.ensureDefault({ workdir: dir1, runtime: 'claude' });
    expect(ws).not.toBeNull();
    expect(ws!.workdir).toBe(dir1);
    expect(ws!.name).toBe(dir1.split('/').pop());
    expect(ws!.runtime).toBe('claude');
    expect(ws!.chatId).toBeUndefined();
    expect(mgr.list()).toHaveLength(1);
  });

  it('is idempotent on repeated calls', () => {
    const a = mgr.ensureDefault({ workdir: dir1, runtime: 'claude' });
    const b = mgr.ensureDefault({ workdir: dir1, runtime: 'claude' });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.name).toBe(b!.name);
    expect(mgr.list()).toHaveLength(1);
  });

  it('dedups by resolved path — returns existing entry if a TL_WORKSPACES entry matches', () => {
    mgr.register({ name: 'project-x', workdir: dir1, runtime: 'claude' });
    const ws = mgr.ensureDefault({ workdir: dir1, runtime: 'claude' });
    expect(ws).not.toBeNull();
    expect(ws!.name).toBe('project-x'); // user-provided name wins
    expect(mgr.list()).toHaveLength(1);
  });

  it('appends -2 when basename collides with existing workspace of different path', () => {
    const sameBasenameDir = mkdtempSync(join(tmpdir(), 'name-clash-'));
    const collidingName = sameBasenameDir.split('/').pop()!;
    mgr.register({ name: collidingName, workdir: dir1, runtime: 'claude' });
    const ws = mgr.ensureDefault({ workdir: sameBasenameDir, runtime: 'claude' });
    expect(ws).not.toBeNull();
    expect(ws!.name).toBe(`${collidingName}-2`);
    expect(ws!.workdir).toBe(sameBasenameDir);
    expect(mgr.list()).toHaveLength(2);
  });

  it('returns null and does not register when validateWorkdir fails (not a directory)', () => {
    const ws = mgr.ensureDefault({ workdir: '/totally/not/a/real/path', runtime: 'claude' });
    expect(ws).toBeNull();
    expect(mgr.list()).toHaveLength(0);
  });

  it('respects workdirWhitelist — skips when path is outside whitelist', () => {
    const restricted = new WorkspaceManager({
      persistPath: null,
      workdirWhitelist: ['/opt/allowed'],
    });
    const ws = restricted.ensureDefault({ workdir: dir2, runtime: 'claude' });
    expect(ws).toBeNull();
    expect(restricted.list()).toHaveLength(0);
  });
});

describe('WorkspaceManager.getDefault / lazyBindDefault', () => {
  let dir1: string;
  let mgr: WorkspaceManager;

  beforeEach(() => {
    dir1 = mkdtempSync(join(tmpdir(), 'bind-'));
    mgr = new WorkspaceManager({ persistPath: null, workdirWhitelist: undefined });
  });

  it('getDefault returns the auto-registered workspace while chatId is undefined', () => {
    mgr.ensureDefault({ workdir: dir1, runtime: 'claude' });
    const d = mgr.getDefault();
    expect(d).toBeDefined();
    expect(d!.workdir).toBe(dir1);
    expect(d!.chatId).toBeUndefined();
  });

  it('getDefault returns undefined when no unbound workspace exists', () => {
    expect(mgr.getDefault()).toBeUndefined();
    mgr.register({ name: 'a', workdir: dir1, runtime: 'claude' });
    mgr.openByName('a', { chatId: 'c1' }); // now bound
    expect(mgr.getDefault()).toBeUndefined();
  });

  it('getDefault prefers an unbound workspace over bound ones', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'bind2-'));
    mgr.register({ name: 'alpha', workdir: dir1, runtime: 'claude' });
    mgr.openByName('alpha', { chatId: 'c1' });
    mgr.ensureDefault({ workdir: dir2, runtime: 'claude' });
    const d = mgr.getDefault();
    expect(d).toBeDefined();
    expect(d!.workdir).toBe(dir2);
  });

  it('lazyBindDefault binds chatId + threadId to the unbound default', () => {
    mgr.ensureDefault({ workdir: dir1, runtime: 'claude' });
    const ws = mgr.lazyBindDefault('chat-abc', 'topic-42');
    expect(ws).toBeDefined();
    expect(ws!.chatId).toBe('chat-abc');
    expect(ws!.threadId).toBe('topic-42');
  });

  it('lazyBindDefault is a no-op on subsequent calls (one-shot)', () => {
    mgr.ensureDefault({ workdir: dir1, runtime: 'claude' });
    mgr.lazyBindDefault('chat-1', undefined);
    const second = mgr.lazyBindDefault('chat-2', undefined);
    expect(second).toBeUndefined();
    // First binding is preserved
    expect(mgr.findByThread('chat-1', undefined)).toBeDefined();
    expect(mgr.findByThread('chat-2', undefined)).toBeUndefined();
  });

  it('lazyBindDefault returns undefined when there is no default to bind', () => {
    expect(mgr.lazyBindDefault('chat-1', undefined)).toBeUndefined();
  });

  it('lazyBindDefault preserves undefined threadId (non-forum chat)', () => {
    mgr.ensureDefault({ workdir: dir1, runtime: 'claude' });
    const ws = mgr.lazyBindDefault('chat-xyz', undefined);
    expect(ws).toBeDefined();
    expect(ws!.chatId).toBe('chat-xyz');
    expect(ws!.threadId).toBeUndefined();
  });
});
