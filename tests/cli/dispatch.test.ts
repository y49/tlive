import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CLI = join(process.cwd(), 'scripts', 'cli.js');

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

describe('tlive CLI dispatch', () => {
  let tmpDir: string;
  let sockPath: string;
  let server: net.Server | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tlive-cli-'));
    sockPath = join(tmpDir, 'daemon.sock');
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function stubDaemonSocket() {
    server = net.createServer(() => { /* noop: drop connections */ });
    await new Promise<void>((r) => server!.listen(sockPath, () => r()));
  }

  it('tlive start short-circuits when socket already bound (no fall-through)', async () => {
    await stubDaemonSocket();
    const r = runCli(['start'], { TLIVE_SOCKET_PATH: sockPath, TLIVE_HOME: tmpDir });
    expect(r.stderr).not.toContain('unknown command');
    expect(r.stdout).toContain('already running');
    expect(r.status).toBe(0);
  });
});
