import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/ipc/client.js', () => ({
  ensureDaemonRunning: vi.fn(async () => {}),
  request: vi.fn(async () => ({
    kind: 'session.list',
    sessions: [
      {
        sdkSessionId: 'sid-a',
        shortAlias: 'aaaa',
        workspaceId: 'ws-1',
        workspaceName: 'proj',
        workdir: '/x',
        provider: 'claude',
        kind: 'local',
        status: 'active',
        lastActivityAt: '2026-04-22T00:00:00Z',
        costUsd: 0.01,
      },
    ],
  })),
}));

import { listCommand } from '../../src/cli/list.js';

describe('listCommand', () => {
  it('prints one row per session', async () => {
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    await listCommand();
    write.mockRestore();
    const joined = out.join('');
    expect(joined).toContain('claude');
    expect(joined).toContain('0.0100');
  });

  it('prints "(no sessions)" when empty', async () => {
    const { request } = await import('../../src/ipc/client.js');
    (request as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      kind: 'session.list', sessions: [],
    });
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    await listCommand();
    write.mockRestore();
    expect(out.join('')).toContain('(no sessions)');
  });
});
