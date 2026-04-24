// src/cli/daemon-logs.ts — `tlive daemon-logs [N]`
//
// Tails the daemon's log file (`~/.tlive/daemon.log`, with fallback to the
// legacy `bridge.log`). Reads at most the last 128KB to avoid OOM on very
// large log files and prints the final N lines (default: 50).
//
// `--follow` keeps the file open and prints new appends as they arrive. Ctrl-C
// to stop. We use `fs.watch` with polling rather than a proper follower
// library to keep the dep surface zero — for live streaming of structured
// events use `tlive logs <alias>` (which talks IPC to the daemon).

import { existsSync, statSync, openSync, readSync, closeSync, readFileSync, watchFile, unwatchFile } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_READ = 128 * 1024;

function resolveLogFile(): string | null {
  const home = join(homedir(), '.tlive');
  const candidates = [
    join(home, 'daemon.log'),       // v1.0 default
    join(home, 'logs', 'daemon.log'),
    join(home, 'logs', 'bridge.log'), // legacy v0.x path retained for soft upgrade
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function readTailBytes(path: string, bytes: number): string {
  const size = statSync(path).size;
  if (size <= bytes) return readFileSync(path, 'utf-8');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    readSync(fd, buf, 0, bytes, size - bytes);
    let s = buf.toString('utf-8');
    // Drop the first partial line.
    const firstNewline = s.indexOf('\n');
    if (firstNewline !== -1) s = s.slice(firstNewline + 1);
    return s;
  } finally {
    closeSync(fd);
  }
}

export interface DaemonLogsOptions {
  lines?: number;
  follow?: boolean;
}

export async function daemonLogsCommand(opts: DaemonLogsOptions = {}): Promise<void> {
  const lines = opts.lines ?? 50;
  const path = resolveLogFile();
  if (!path) {
    process.stdout.write('No daemon log yet. Run: tlive start\n');
    return;
  }
  process.stdout.write(`=== ${path} (last ${lines} lines) ===\n`);
  const content = readTailBytes(path, MAX_READ);
  const tail = content.trimEnd().split('\n').slice(-lines);
  if (tail.length > 0) process.stdout.write(tail.join('\n') + '\n');

  if (!opts.follow) return;

  // Follow mode.
  let offset = statSync(path).size;
  await new Promise<void>((resolve) => {
    const handler = (): void => {
      try {
        const size = statSync(path).size;
        if (size < offset) {
          // File was truncated/rotated — restart from 0.
          offset = 0;
        }
        if (size > offset) {
          const fd = openSync(path, 'r');
          try {
            const len = Math.min(size - offset, MAX_READ * 4);
            const buf = Buffer.alloc(len);
            readSync(fd, buf, 0, len, offset);
            process.stdout.write(buf.toString('utf-8'));
            offset += len;
          } finally { closeSync(fd); }
        }
      } catch { /* keep polling */ }
    };
    watchFile(path, { interval: 500 }, handler);
    const stop = (): void => {
      try { unwatchFile(path, handler); } catch { /* ignore */ }
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

if (process.argv[1]?.endsWith('tlive-daemon-logs.mjs')) {
  const argv = process.argv.slice(2);
  const follow = argv.includes('--follow') || argv.includes('-f');
  const n = (() => {
    const numArg = argv.find((a) => /^\d+$/.test(a));
    return numArg ? parseInt(numArg, 10) : 50;
  })();
  await daemonLogsCommand({ lines: n, follow });
}
