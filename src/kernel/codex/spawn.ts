import { spawn as nodeSpawn } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { commandOnPath } from '../integrations/hooks-cleanup.js';

export function codexAppServerSockPath(codexHome?: string): string {
  const home = codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  return join(home, 'app-server-control', 'app-server-control.sock');
}

export interface AppServerCustody {
  adopted: boolean;
  stop: () => void;
}

interface ChildLike {
  pid?: number;
  on: Function;
  kill: Function;
  unref?: Function;
}

const FAST_EXIT_MS = 5000;
const MAX_BACKOFF_MS = 30_000;
const MAX_FAST_EXITS = 6;

function defaultProbe(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect(sockPath);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 1000);
    timer.unref?.();
    sock.once('connect', () => {
      clearTimeout(timer);
      finish(true);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/** `detached` is the whole point: the app-server outlives us on purpose.
 *  A Codex TUI attaches to whatever app-server owns the control socket, so the
 *  instance is SHARED — tearing it down with the tlive daemon orphans every TUI
 *  currently on it (they keep running, invisible to tlive, while
 *  `tlive status` still claims a companion is connected). Codex makes the same
 *  call for its own managed backend: `Stdio::null()` + `pre_exec { setsid() }`
 *  in app-server-daemon/src/backend/pid.rs, pid-file tracked, never a child of
 *  whoever asked for it. We cannot delegate to `codex app-server daemon start`
 *  instead — that path requires the standalone managed install
 *  (`~/.codex/packages/standalone/current/codex`, see
 *  app-server-daemon/src/lib.rs `ensure_managed_codex_bin`) and hard-errors for
 *  everyone who installed Codex from npm. */
export function appServerSpawnOptions(fd: number): { detached: boolean; stdio: ['ignore', number, number] } {
  return { detached: true, stdio: ['ignore', fd, fd] };
}

function defaultSpawnFn(logPath: string): ChildLike {
  const fd = openSync(logPath, 'a');
  const child = nodeSpawn('codex', ['app-server', '--listen', 'unix://'], appServerSpawnOptions(fd));
  // spawn() 内部已 dup 该 fd 给子进程的 stdout/stderr,子进程持有独立的描述符引用,
  // 父进程这份 fd 用完即可关闭,否则每次 respawn 都会泄漏一个 fd。
  try {
    closeSync(fd);
  } catch {
    // best-effort close; a failure here must not crash the daemon
  }
  return child;
}

export async function ensureCodexAppServer(opts: {
  logPath: string;
  probe?: (sockPath: string) => Promise<boolean>;
  spawnFn?: (logPath: string) => ChildLike;
  onStateChange?: (s: 'running' | 'degraded') => void;
  platform?: NodeJS.Platform;
  hasCodex?: () => boolean;
}): Promise<AppServerCustody | null> {
  const platform = opts.platform ?? process.platform;
  const hasCodex = opts.hasCodex ?? (() => commandOnPath('codex'));
  if (platform === 'win32' || !hasCodex()) return null;

  const probe = opts.probe ?? defaultProbe;
  const spawnFn = opts.spawnFn ?? defaultSpawnFn;
  const onStateChange = opts.onStateChange ?? (() => {});

  const sockPath = codexAppServerSockPath();
  const listening = await probe(sockPath);
  if (listening) {
    onStateChange('running');
    return { adopted: true, stop: () => {} };
  }

  let stopped = false;
  let fastExitStreak = 0;
  let currentBackoffMs = 1000;
  let respawnTimer: NodeJS.Timeout | undefined;
  let child: ChildLike;

  const scheduleRespawn = () => {
    if (stopped) return;
    if (fastExitStreak >= MAX_FAST_EXITS) {
      onStateChange('degraded');
      return;
    }
    respawnTimer = setTimeout(() => {
      if (stopped) return;
      spawnChild();
    }, currentBackoffMs);
    respawnTimer.unref?.();
    currentBackoffMs = Math.min(currentBackoffMs * 2, MAX_BACKOFF_MS);
  };

  const spawnChild = () => {
    const spawnedAt = Date.now();
    child = spawnFn(opts.logPath);
    let settled = false;
    const onDeath = () => {
      // A child can emit both 'error' and 'exit' for the same failure — only
      // count/react once per child, or the fast-exit streak double-counts and
      // scheduleRespawn fires twice (double-spawn).
      if (settled) return;
      settled = true;
      if (stopped) return;
      const lived = Date.now() - spawnedAt;
      if (lived < FAST_EXIT_MS) {
        fastExitStreak += 1;
      } else {
        fastExitStreak = 0;
        currentBackoffMs = 1000;
      }
      scheduleRespawn();
    };
    // Async spawn failures (ENOENT TOCTOU, EACCES, EMFILE) emit 'error' and
    // never 'exit' — without this listener that's an uncaught exception that
    // crashes the daemon and backoff never engages.
    child.on('error', onDeath);
    child.on('exit', onDeath);
    // Detached above; unref'd here so this supervised-but-independent process
    // never holds the daemon's event loop open. 'exit' still arrives for as
    // long as we are alive, which is all the respawn logic needs.
    child.unref?.();
    onStateChange('running');
  };

  spawnChild();

  return {
    adopted: false,
    // Stops SUPERVISION, not the app-server. Same shape as the adopted branch
    // above, and for the same reason: the socket — not our custody of it — is
    // the rendezvous point, so the next daemon start re-adopts this very
    // instance and every TUI already attached to it stays visible. Nothing
    // leaks that Codex itself would not leak: its own daemon keeps one
    // app-server alive across clients by design.
    stop: () => {
      stopped = true;
      if (respawnTimer) clearTimeout(respawnTimer);
    },
  };
}
