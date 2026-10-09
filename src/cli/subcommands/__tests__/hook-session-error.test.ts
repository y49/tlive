import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../hook.js';

const { request, loadConfig } = vi.hoisted(() => ({ request: vi.fn(), loadConfig: vi.fn() }));
vi.mock('../../../kernel/ipc/client.js', () => ({ request }));
vi.mock('../../../kernel/config/loader.js', () => ({ loadConfig }));
let dir: string;
let path: string;
describe('StopFailure hook transcript enrichment', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    loadConfig.mockReturnValue({ mode: 'notify' });
    request.mockResolvedValue({ kind: 'hook.notify.result' });
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.stubEnv('TLIVE_HOME', '/unused-tlive-test-home');
    dir = await mkdtemp(join(tmpdir(), 'tlive-hook-failure-'));
    path = join(dir, 'transcript.jsonl');
    await writeFile(path, [
      { type: 'user', sessionId: 's', message: { role: 'user', content: 'private prompt' } },
      { type: 'system', subtype: 'api_error', sessionId: 's', error: { message: 'SSL hostname mismatch https://user:secret@private.test/?token=secret' } },
    ].map(v => JSON.stringify(v)).join('\n'));
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
      yield Buffer.from(JSON.stringify({ cwd: '/project', session_id: 's', error: 'server_error', transcript_path: path, message: 'normal notification' }));
    });
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

  it('sends recovered redacted TLS details and a permanent classification over IPC', async () => {
    await runHook(['stop-failure']);
    const payload = request.mock.calls[0][0];
    expect(payload.sessionError).toMatchObject({ category: 'tls', retryable: false, transient: false });
    expect(payload.message).toContain('SSL hostname mismatch');
    expect(JSON.stringify(payload)).not.toMatch(/secret|private\.test|private prompt/);
  });
  it('leaves ordinary notifications unaffected by transcript contents', async () => {
    await runHook(['notification']);
    const payload = request.mock.calls[0][0];
    expect(payload.message).toBe('normal notification');
    expect(payload.sessionError).toBeUndefined();
  });
});
