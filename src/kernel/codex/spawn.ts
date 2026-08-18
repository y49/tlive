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

/** No `kill`: this process outlives us by design, so the supervisor must not
 *  even be able to reach for it. */
interface ChildLike {
  pid?: number;
  on: Function;
  unref?: Function;
}

const MAX_BACKOFF_MS = 30_000;
/** Consecutive failed checks before we stop calling the state 'running' and
 *  admit 'degraded'. NOT a give-up threshold — see the tick loop: there is no
 *  give-up, only a wider backoff. */
const FAILURES_BEFORE_DEGRADED = 6;
/** How long a healthy app-server goes unchecked. This is the window in which a
 *  dead one is invisible, so it is also the worst-case time to recovery. */
const HEALTH_INTERVAL_MS = 15_000;
/** After a spawn, how soon we look for the socket it should have opened. */
const SETTLE_MS = 1000;

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

  let stopped = false;
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  let reported: 'running' | 'degraded' | undefined;

  // Report transitions only: a 15s poll would otherwise repeat itself forever.
  const setState = (s: 'running' | 'degraded'): void => {
    if (s === reported) return;
    reported = s;
    onStateChange(s);
  };

  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => { void tick(); }, ms);
    timer.unref?.();
  };

  const spawnOnce = (): void => {
    const child = spawnFn(opts.logPath);
    // Async spawn failures — ENOENT TOCTOU, EACCES, EMFILE — emit 'error' and
    // never 'exit'; without a listener that is an uncaught exception that takes
    // the daemon down. Death itself needs no handling here: the next tick's
    // probe is what decides whether an app-server exists.
    child.on('error', () => {});
    child.on('exit', () => {});
    // Detached at spawn; unref'd so this independent process never holds the
    // daemon's event loop open.
    child.unref?.();
  };

  /** One question, asked on a loop: is an app-server listening?
   *
   *  Deliberately NOT "is the child we spawned still alive". The instance is
   *  shared — it may have been started by a previous daemon, by `codex
   *  app-server daemon start`, or by us — and supervising only our own child
   *  left an ADOPTED instance completely unwatched: when it died, nothing
   *  brought it back and `tlive status` kept reporting a running companion
   *  because the state came from "we called spawn once", not from anything
   *  answering. Now that a restart always adopts rather than replaces, that was
   *  every restart.
   *
   *  There is also no give-up. The old supervisor stopped scheduling after six
   *  fast exits, which is exactly what an uninstall looks like: `codex` leaves
   *  PATH, every respawn ENOENTs instantly, the budget burns in under a minute
   *  and reinstalling never revived it — the daemon had to be restarted by
   *  hand. Failures now only widen the backoff and change what we report.
   *
   *  Returns whether one was already listening, which the first call reports
   *  as `adopted`. */
  async function tick(): Promise<boolean> {
    if (stopped) return false;
    let nextMs = HEALTH_INTERVAL_MS;
    let listening = false;
    try {
      listening = await probe(sockPath);
      // stop() can land while the probe is still in flight; without this the
      // code below would start an app-server the daemon has already finished
      // with, and nothing would ever stop it.
      if (stopped) return listening;
      if (listening) {
        failures = 0;
        setState('running');
      } else if (!hasCodex()) {
        // Nothing to spawn: stay quiet and keep looking, so a reinstall
        // recovers on its own instead of requiring `tlive stop && tlive start`.
        setState('degraded');
      } else {
        failures += 1;
        setState(failures > FAILURES_BEFORE_DEGRADED ? 'degraded' : 'running');
        spawnOnce();
        nextMs = failures > FAILURES_BEFORE_DEGRADED ? MAX_BACKOFF_MS : Math.min(SETTLE_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
      }
    } catch {
      // An escaping throw would skip the reschedule below and end the loop —
      // the same permanent give-up this supervisor exists to prevent, arriving
      // through a different door. Both halves can throw for real:
      // `defaultSpawnFn` opens the log file first, so EACCES / ENOSPC / EMFILE
      // land here synchronously, and an injected probe may reject.
      // Report it rather than staying silent: the state machine has to stay
      // total, or the daemon is left holding whatever it assumed at startup.
      setState('degraded');
      failures += 1;
      nextMs = MAX_BACKOFF_MS;
    }
    schedule(nextMs);
    return listening;
  }

  // Startup is just the loop's first turn: one code path, so a probe that
  // throws on the very first call cannot take the whole companion down with it
  // (bootstrap turns a rejection here into "no companion, ever").
  const adopted = await tick();

  return {
    adopted,
    // Stops SUPERVISION, not the app-server. The socket — not our custody of
    // it — is the rendezvous point, so the next daemon start re-adopts this
    // very instance and every TUI already attached to it stays visible.
    // Nothing leaks that Codex itself would not leak: its own daemon keeps one
    // app-server alive across clients by design.
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
