//
// Single daemon web token. Persisted at <home>/web-token (0600). The web server
// gates every http page + ws upgrade on it; first ?token= match sets an httpOnly cookie.

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';

export function loadOrCreateToken(home: string): string {
  const p = join(home, 'web-token');
  if (existsSync(p)) {
    const t = readFileSync(p, 'utf8').trim();
    if (t) return t;
  }
  mkdirSync(home, { recursive: true });
  const token = randomBytes(24).toString('base64url');
  writeFileSync(p, token + '\n', { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* perms best-effort (e.g. Windows) */ }
  return token;
}
