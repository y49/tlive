// tests/integration/daemon-lock.test.ts
//
// Verifies the daemon.lock multi-instance prevention (spec §2 lock).
// Spawns real tlive-daemon.mjs processes against an isolated TLIVE_HOME
// so the user's running daemon (~/.tlive) is never touched.
//
// Two cases:
//   1. A second daemon spawned while the first is alive must exit 73 and
//      write "another daemon already running" to stderr.
//   2. After the first daemon terminates cleanly (SIGTERM), a subsequent
//      spawn should acquire the lock and keep running.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DAEMON_ENTRY = join(__dirname, '..', '..', 'dist', 'src', 'tlive-daemon.mjs');

/** Spawn a daemon pointing at `home`, with IM adapters implicitly disabled
 *  because there is no config (empty TLIVE_HOME → fresh install → no tokens).
 */
function spawnDaemon(home: string) {
  return spawn(process.execPath, [DAEMON_ENTRY], {
    env: {
      ...process.env,
      TLIVE_HOME: home,
      // Suppress real adapter start by pointing at an empty home (no config →
      // no telegram/feishu tokens → adapters skipped by defaultAdapterFactory).
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitMs(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe('daemon lock — multi-instance prevention', () => {
  let home: string;
  let firstChild: ReturnType<typeof spawn> | null;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tlive-lock-it-'));
    firstChild = null;
  });

  afterEach(() => {
    if (firstChild && !firstChild.killed) firstChild.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  });

  it('second daemon exits 73 when first is alive', async () => {
    if (!existsSync(DAEMON_ENTRY)) {
      throw new Error(`build first: ${DAEMON_ENTRY} not found`);
    }

    firstChild = spawnDaemon(home);
    // Wait for first daemon to acquire the lock and reach steady state.
    await waitMs(2000);

    const second = spawnSync(process.execPath, [DAEMON_ENTRY], {
      env: { ...process.env, TLIVE_HOME: home },
      timeout: 5000,
    });

    expect(second.status).toBe(73);
    expect(second.stderr.toString()).toMatch(/another daemon already running/);
  }, 15_000);

  it('after first exits, second daemon acquires lock', async () => {
    if (!existsSync(DAEMON_ENTRY)) {
      throw new Error(`build first: ${DAEMON_ENTRY} not found`);
    }

    firstChild = spawnDaemon(home);
    await waitMs(2000);

    // Terminate first daemon gracefully.
    firstChild.kill('SIGTERM');
    await waitMs(1500);

    // Second daemon should now acquire the lock and keep running.
    const second = spawnDaemon(home);
    await waitMs(2000);

    expect(second.exitCode).toBeNull(); // still running — lock acquired

    second.kill('SIGTERM');
  }, 15_000);
});
