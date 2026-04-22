import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/cli/ipc-client-lite.js', () => ({
  ensureDaemonRunning: vi.fn(async () => {}),
  sendRequest: vi.fn(async () => ({ type: 'session_created', payload: { sessionId: 'sid-42' } })),
}));

import { resumeCommand } from '../../src/cli/resume.js';

describe('resumeCommand', () => {
  it('prints resumed line on session_created', async () => {
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    await resumeCommand('sid-42');
    write.mockRestore();
    expect(out.join('')).toContain('resumed sid-42');
  });
});
