import { describe, it, expect, vi } from 'vitest';
import { PermissionRouter } from '../permission-router';
import { WorkspaceRegistry } from '../../workspace/registry';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('PermissionRouter', () => {
  it('attaches MCP subprocess by cwd → workspace', () => {
    const home = mkdtempSync(join(tmpdir(), 'tlive-pr-'));
    const ws = new WorkspaceRegistry({ home });
    ws.add('ws-foo', '/projects/foo');
    const r = new PermissionRouter({ workspaces: ws });
    const out = r.attach({ cwd: '/projects/foo/src', pid: 12345 });
    expect(out).toBe('ws-foo');
  });

  it('returns null + logs warning when cwd has no workspace', () => {
    const home = mkdtempSync(join(tmpdir(), 'tlive-pr-'));
    const ws = new WorkspaceRegistry({ home });
    const r = new PermissionRouter({ workspaces: ws });
    const out = r.attach({ cwd: '/nowhere', pid: 1 });
    expect(out).toBeNull();
  });

  it('routes permission to bound chats; deny when none bound', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tlive-pr-'));
    const ws = new WorkspaceRegistry({ home });
    ws.add('ws-foo', '/projects/foo');
    const sender = vi.fn().mockResolvedValue(undefined);
    const r = new PermissionRouter({ workspaces: ws, sendToChat: sender });
    r.attach({ cwd: '/projects/foo', pid: 1 });

    // No chat bound for ws-foo → deny immediately
    const result = await r.requestPermission({
      pid: 1, toolName: 'Bash', input: { cmd: 'ls' },
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/no IM chat bound/);
  });
});
