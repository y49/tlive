// src/kernel/daemon/log-rotate.ts
//
// A ceiling for daemon.log. The inbox has had an age + total-size cap since it
// was written; the log — the one file every diagnostic path appends to — had
// none, and a single incident on 2026-08-14 (a reconnect loop whose backoff
// doubled per failure, 221,547 identical lines in one hour) left 115MB on disk
// that nothing was ever going to reclaim.
//
// Truncate-in-place, NOT rename-and-reopen: the daemon's stdout/stderr is an
// inherited O_APPEND fd opened by `spawnDaemonDetached`, so renaming the file
// would leave that fd writing into the renamed inode forever and daemon.log
// would never come back. An O_APPEND write always seeks to the end, so a file
// rewritten underneath it is picked up correctly on the next line.
//
// Keeping the tail rather than wiping the file is what makes this acceptable:
// the newest lines are the ones a diagnosis needs, and they are exactly the
// ones a "delete it all" cap would throw away.

import { statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';

/** Rotate above this. Roomy on purpose: normal traffic is a few hundred JSON
 *  lines a day, so this holds months, and only a runaway ever reaches it. */
export const LOG_CAP_BYTES = 16 * 1024 * 1024;
/** How much of the tail survives a rotation. */
export const LOG_KEEP_BYTES = 2 * 1024 * 1024;

/** Truncate `path` to its last `keepBytes` if it exceeds `capBytes`.
 *  Returns the number of bytes dropped, or null when nothing was done
 *  (under the cap, or no such file — a daemon that has not logged yet is not
 *  an error). Never throws: a log that cannot be rotated must not take the
 *  daemon down with it. */
export function rotateIfOversized(
  path: string,
  opts: { capBytes?: number; keepBytes?: number } = {},
): number | null {
  const cap = opts.capBytes ?? LOG_CAP_BYTES;
  const keep = opts.keepBytes ?? LOG_KEEP_BYTES;
  try {
    const size = statSync(path).size;
    if (size <= cap) return null;
    const buf = Buffer.alloc(Math.min(keep, size));
    const fd = openSync(path, 'r');
    try { readSync(fd, buf, 0, buf.length, size - buf.length); } finally { closeSync(fd); }
    // Start at a line boundary: the read almost certainly lands mid-line, and
    // half a JSON object at the top of the log breaks every `grep '^{'` and
    // every JSON.parse the diagnosis paths do.
    const nl = buf.indexOf(0x0a);
    const tail = nl === -1 ? Buffer.alloc(0) : buf.subarray(nl + 1);
    const dropped = size - tail.length;
    // Says so in the log's own shape, so the gap is visible to the same tools
    // that read everything else. A silent gap reads as "nothing happened".
    const marker = `${JSON.stringify({
      ts: new Date().toISOString(),
      level: 'warn',
      msg: 'log.truncated',
      droppedBytes: dropped,
      keptBytes: tail.length,
    })}\n`;
    writeFileSync(path, Buffer.concat([Buffer.from(marker), tail]));
    return dropped;
  } catch {
    return null;
  }
}
