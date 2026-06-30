import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionRouter } from '../permission-router';
import { WorkspaceRegistry } from '../../workspace/registry';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('PermissionRouter (cwd-based, allow/deny/defer)', () => {
  it('defers with defer decision after timeout (finding 1: bounded pending)', async () => {
    vi.useFakeTimers();
    const home = mkdtempSync(join(tmpdir(), 'tlive-pr-'));
    const ws = new WorkspaceRegistry({ home });
    ws.add('ws-foo', '/projects/foo');
    const r = new PermissionRouter({
      workspaces: ws,
      chatsForWorkspace: () => [{ channel: 'telegram', chatId: 'c1' }],
      sendToChat: vi.fn().mockResolvedValue(undefined),
    });
    const p = r.requestPermission({ cwd: '/projects/foo', toolName: 'Bash', input: {} });
    // Advance past the 250 s timeout
    vi.advanceTimersByTime(251_000);
    const result = await p;
    expect(result.decision).toBe('defer');
    vi.useRealTimers();
  });

  it('defers when no workspace matches cwd', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tlive-pr-'));
    const ws = new WorkspaceRegistry({ home });
    const r = new PermissionRouter({
      workspaces: ws,
      chatsForWorkspace: () => [],
      sendToChat: vi.fn(),
    });
    const result = await r.requestPermission({ cwd: '/nowhere', toolName: 'Bash', input: {} });
    expect(result.decision).toBe('defer');
  });

  it('defers when workspace found but no chat bound', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tlive-pr-'));
    const ws = new WorkspaceRegistry({ home });
    ws.add('ws-foo', '/projects/foo');
    const r = new PermissionRouter({
      workspaces: ws,
      chatsForWorkspace: () => [],
      sendToChat: vi.fn(),
    });
    const result = await r.requestPermission({ cwd: '/projects/foo/src', toolName: 'Edit', input: {} });
    expect(result.decision).toBe('defer');
  });

  it('returns allow when answered true', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tlive-pr-'));
    const ws = new WorkspaceRegistry({ home });
    ws.add('ws-foo', '/projects/foo');
    let capturedId = '';
    const r = new PermissionRouter({
      workspaces: ws,
      chatsForWorkspace: () => [{ channel: 'telegram', chatId: 'c1' }],
      sendToChat: async (_, card) => { capturedId = card.requestId; },
    });
    const p = r.requestPermission({ cwd: '/projects/foo', toolName: 'Bash', input: { cmd: 'ls' } });
    // Wait a tick for sendToChat to be called (captures requestId)
    await new Promise((res) => setTimeout(res, 0));
    r.answer(capturedId, true);
    const result = await p;
    expect(result.decision).toBe('allow');
  });

  it('returns deny when answered false', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tlive-pr-'));
    const ws = new WorkspaceRegistry({ home });
    ws.add('ws-foo', '/projects/foo');
    let capturedId = '';
    const r = new PermissionRouter({
      workspaces: ws,
      chatsForWorkspace: () => [{ channel: 'telegram', chatId: 'c1' }],
      sendToChat: async (_, card) => { capturedId = card.requestId; },
    });
    const p = r.requestPermission({ cwd: '/projects/foo/src', toolName: 'Write', input: {} });
    await new Promise((res) => setTimeout(res, 0));
    r.answer(capturedId, false);
    const result = await p;
    expect(result.decision).toBe('deny');
  });
});
