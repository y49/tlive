// src/kernel/session/persistence.ts
//
// Persists SessionContextSnapshot to disk so that resume across restart
// has the providerSessionId mapping.

import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import type { SessionContextSnapshot } from './context.js';

export class SessionPersistence {
  private readonly dir: string;

  constructor(home: string) {
    this.dir = join(home, 'sessions');
    mkdirSync(this.dir, { recursive: true });
  }

  save(snap: SessionContextSnapshot): void {
    writeFileSync(join(this.dir, `${snap.tliveSessionId}.json`), JSON.stringify(snap, null, 2));
  }

  load(tliveSessionId: string): SessionContextSnapshot | null {
    const p = join(this.dir, `${tliveSessionId}.json`);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  }

  list(): SessionContextSnapshot[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf-8')));
  }
}
