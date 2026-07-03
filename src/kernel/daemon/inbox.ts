// src/kernel/daemon/inbox.ts
//
// Housekeeping for ~/.tlive/inbox (IM/web uploaded attachments). Files are
// only ever inputs handed to an agent — they are disposable. Two limits keep
// the directory maintenance-free: max age AND max total size (oldest first).

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface InboxLimits {
  maxAgeMs: number;
  maxTotalBytes: number;
}

export const DEFAULT_LIMITS: InboxLimits = {
  maxAgeMs: 48 * 3600_000,          // 2 days — long enough for "look at this later"
  maxTotalBytes: 256 * 1024 * 1024, // 256 MB cap regardless of age
};

/** Delete expired files, then trim oldest-first to the size cap. Returns #deleted. */
export function sweepInbox(dir: string, limits: InboxLimits = DEFAULT_LIMITS, now = Date.now()): number {
  let files: Array<{ path: string; mtime: number; size: number }>;
  try {
    files = readdirSync(dir).map((f) => {
      const p = join(dir, f);
      const st = statSync(p);
      return { path: p, mtime: st.mtimeMs, size: st.size };
    });
  } catch {
    return 0; // no inbox yet
  }
  let deleted = 0;
  const keep: typeof files = [];
  for (const f of files) {
    if (now - f.mtime > limits.maxAgeMs) {
      try { unlinkSync(f.path); deleted++; } catch { /* ignore */ }
    } else {
      keep.push(f);
    }
  }
  keep.sort((a, b) => a.mtime - b.mtime); // oldest first
  let total = keep.reduce((s, f) => s + f.size, 0);
  for (const f of keep) {
    if (total <= limits.maxTotalBytes) break;
    try { unlinkSync(f.path); deleted++; total -= f.size; } catch { /* ignore */ }
  }
  return deleted;
}
