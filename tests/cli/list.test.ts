import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/cli/ipc-client-lite.js', () => ({
  ensureDaemonRunning: vi.fn(async () => {}),
  sendRequest: vi.fn(async () => ({
    type: 'session_list', payload: { sessions: [
      { id: 'a', ctx: { provider: 'claude', workdir: '/x' }, status: 'active',
        cost: { costUsd: 0.01, inputTokens: 0, outputTokens: 0, durationMs: 0 } },
    ] },
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

  it('prints "(no active sessions)" when empty', async () => {
    const { sendRequest } = await import('../../src/cli/ipc-client-lite.js');
    (sendRequest as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'session_list', payload: { sessions: [] },
    });
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    await listCommand();
    write.mockRestore();
    expect(out.join('')).toContain('(no active sessions)');
  });
});
