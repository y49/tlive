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
