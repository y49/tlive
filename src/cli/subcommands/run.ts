// src/cli/subcommands/run.ts
import { randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync } from 'node:fs';
import { SessionHost } from '../../kernel/pty/session-host.js';
import { defaultSocketPath, sessionSocketPath, request } from '../../kernel/ipc/client.js';
import type { SessionMeta } from '../../kernel/ipc/protocol.js';
import { resolveWebUrls } from '../web-url.js';

export function gitBranch(cwd: string): string | null {
  try {
    const head = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return m && m[1] ? m[1] : null;
  } catch {
    return null;
  }
}

export function deriveLabel(cmd: string, cwd: string): string {
  const base = basename(cwd) || cwd;
  const branch = gitBranch(cwd);
  return branch ? `${cmd} @ ${base} (${branch})` : `${cmd} @ ${base}`;
}

export async function runRun(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    process.stderr.write('Usage: tlive run <cmd> [args...]\n');
    process.exit(1);
  }
  // Refuse to nest (same policy as tmux): a wrapped-in-wrapped pty doubles the
  // relay AND both sessions share one cwd — the registry keys by cwd, so the
  // two cards would clobber each other's socket.
  if (process.env.TLIVE_SESSION) {
    process.stderr.write(
      'tlive: already inside a tlive session (TLIVE_SESSION is set) — nesting is disabled.\n' +
      '       This terminal is already served on the web; open another terminal to start a second session,\n' +
      '       or force with: TLIVE_SESSION= tlive run <cmd>\n',
    );
    process.exit(1);
  }

  const [cmd, ...args] = argv;
  const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
  mkdirSync(join(home, 'sessions'), { recursive: true });

  const id = randomUUID();
  const sockPath = sessionSocketPath(home, id);
  const cwd = process.cwd();
  const label = deriveLabel(cmd, cwd);
  const sock = defaultSocketPath();

  // Banner BEFORE the pty attaches (raw mode + program output start after host.start()).
  // The web terminal is served by the daemon — probe it so a stopped daemon
  // shows a hint instead of an unreachable URL. The LOCAL terminal works regardless.
  const daemonUp = await request({ kind: 'daemon.status' }, { socketPath: sock, timeoutMs: 800 }).then(() => true).catch(() => false);
  const urls = resolveWebUrls(home);
  if (!daemonUp) {
    process.stdout.write('\n⚠ tlive daemon not running — web terminal/dashboard unavailable.\n  Start it in another terminal: tlive start   (this local session still works)\n');
  } else if (urls.enabled && urls.token) {
    const sess = (base: string): string => base.replace('/?', `/s/${encodeURIComponent(id)}?`);
    process.stdout.write('\ntlive web UI:\n');
    if (urls.local) process.stdout.write(`  Local:    ${sess(urls.local)}\n`);
    if (urls.network) process.stdout.write(`  Network:  ${sess(urls.network)}\n`);
    process.stdout.write(`  Session:  ${label} (id: ${id})\n`);
    const qrTarget = urls.network ? sess(urls.network) : urls.local ? sess(urls.local) : null;
    if (qrTarget) {
      const { default: qr } = await import('qrcode-terminal');
      qr.generate(qrTarget, { small: true }, (out) => process.stdout.write(out + '\n'));
    }
    // A full-screen TUI (claude) will clear this banner — remind how to get it back.
    process.stdout.write('  (a full-screen app hides this — run `tlive url` in another terminal anytime)\n');
  } else if (urls.enabled) {
    process.stdout.write('\ntlive web UI: token not created yet — run `tlive start` first for a link + QR.\n');
  }

  const host = new SessionHost({ id, cmd, args, cwd, sockPath, attachLocal: true });
  await host.start();

  const meta: SessionMeta = { id, label, cmd, cwd, pid: process.pid, sockPath };
  // The pty lives in THIS process and outlives the daemon — so we can't just
  // register once. Poll daemon.status; whenever its pid changes (a restart, or
  // it coming up for the first time), re-register so the session reappears in
  // the list. Registration is idempotent; the local terminal works regardless.
  let daemonPid: number | null = null;
  const syncRegister = async (): Promise<void> => {
    try {
      const r = await request({ kind: 'daemon.status' }, { socketPath: sock, timeoutMs: 800 });
      if (r.kind === 'daemon.status' && r.pid !== daemonPid) {
        await request({ kind: 'session.register', session: meta }, { socketPath: sock, timeoutMs: 1500 }).catch(() => undefined);
        daemonPid = r.pid;
      }
    } catch { daemonPid = null; } // daemon down → re-register when it returns with a new pid
  };
  await syncRegister(); // register now (if the daemon is up)
  const regTimer = setInterval(() => void syncRegister(), 5000);
  regTimer.unref();

  // Guard against the double-finish under a signal: onSignal calls host.stop()
  // (→ finish(130)) AND pty.onExit fires (→ finish(exitCode)). First wins.
  let finished = false;
  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    clearInterval(regTimer);
    void request({ kind: 'session.unregister', id }, { socketPath: sock, timeoutMs: 1500 })
      .catch(() => undefined)
      .finally(() => process.exit(code));
  };
  host.onExit(finish);

  let exiting = false;
  const onSignal = (): void => {
    if (exiting) return;
    exiting = true;
    void host.stop().finally(() => finish(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}
