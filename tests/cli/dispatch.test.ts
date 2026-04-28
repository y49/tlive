import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CLI = join(process.cwd(), 'scripts', 'cli.js');

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    timeout: 6000,
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

  it('tlive start short-circuits when daemon PID is alive (own pid as proxy)', async () => {
    // Authoritative liveness is the PID file → process.kill(pid, 0). Use
    // the test process's own pid as a stand-in for "definitely alive".
    writeFileSync(join(tmpDir, 'daemon.pid'), String(process.pid));
    const r = runCli(['start'], { TLIVE_SOCKET_PATH: sockPath, TLIVE_HOME: tmpDir });
    expect(r.stderr).not.toContain('unknown command');
    expect(r.stdout).toContain('already running');
    expect(r.stdout).toContain(`pid ${process.pid}`);
    expect(r.status).toBe(0);
  });

  it('tlive start cleans stale pid + socket when PID is dead (zombie cleanup)', () => {
    // Pick a PID that is reliably dead — well above pid_max on Linux/macOS,
    // so isPidAlive returns false and the start path falls through to the
    // detach-spawn code (which fails because dist/ isn't built in the test
    // sandbox, but stderr will show the cleanup messages we care about).
    writeFileSync(join(tmpDir, 'daemon.pid'), '4194305');
    // Drop a stale socket file alongside the pid.
    writeFileSync(sockPath, '');
    const r = runCli(['start'], { TLIVE_SOCKET_PATH: sockPath, TLIVE_HOME: tmpDir });
    expect(r.stderr).toContain('cleaning stale pid file');
    expect(r.stderr).toContain('cleaning stale socket');
    // After cleanup the start tries to spawn; the spawn either succeeds (if
    // dist/ is built) or fails with a "Run: npm run build" message — either
    // way the stale-cleanup branches fired, which is what the test asserts.
    expect(existsSync(join(tmpDir, 'daemon.pid'))).toBe(false);
    expect(existsSync(sockPath)).toBe(false);
  });

  it('tlive restart is wired in DISPATCH (not flagged as unknown)', () => {
    // A naked `tlive restart` triggers the restart entrypoint. The dist
    // entry may not exist in test sandbox; we just assert the dispatcher
    // recognized it (no "unknown command" / "Did you mean" output).
    const r = runCli(['restart'], { TLIVE_HOME: tmpDir });
    expect(r.stderr).not.toContain('unknown command `restart`');
    expect(r.stderr).not.toContain('Did you mean');
  });

  it('tlive --help advertises restart', () => {
    const r = runCli(['--help']);
    expect(r.stdout).toContain('tlive restart');
  });

  it('tlive list prints migration hint pointing at /sessions', () => {
    const r = runCli(['list']);
    expect(r.stderr).toContain('/sessions');
    expect(r.status).toBe(2);
  });

  it('tlive logs prints migration hint pointing at daemon-logs', () => {
    const r = runCli(['logs', 'some-alias']);
    expect(r.stderr).toContain('daemon-logs');
    expect(r.status).toBe(2);
  });

  it('tlive stop-daemon prints rename hint pointing at tlive stop', () => {
    const r = runCli(['stop-daemon']);
    expect(r.stderr).toContain('Renamed to `tlive stop`');
    expect(r.status).toBe(2);
  });

  it('tlive stop with extra arg prints /kill hint', () => {
    const r = runCli(['stop', 'some-alias']);
    expect(r.stderr).toContain('/kill');
    expect(r.status).toBe(2);
  });

  it('unknown typo still triggers a Did-you-mean suggestion', () => {
    const r = runCli(['statuz']);
    expect(r.stderr).toContain('Did you mean: tlive status');
    expect(r.status).toBe(1);
  });
});
