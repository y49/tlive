// src/kernel/daemon/__tests__/web-bootstrap.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapDaemon, type DaemonHandle } from '../bootstrap.js';

let tmp: string;
let h: DaemonHandle;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'tlive-web-')); });
afterEach(async () => { await h?.shutdown(); });

describe('daemon web server', () => {
  it('starts a token-gated web server and serves /api/sessions', async () => {
    // port 0 → ephemeral; inject via config to avoid port conflicts
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 } }));
    h = await bootstrapDaemon({ home: tmp });
    expect(h.webUrl).toBeDefined();
    const url = new URL(h.webUrl!);
    const bad = await fetch(`http://${url.host}/api/sessions`);
    expect(bad.status).toBe(401);
    const good = await fetch(`${url.origin}/api/sessions${url.search}`);
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual([]);
  });

  it('omits the web server when web.enabled is false', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    h = await bootstrapDaemon({ home: tmp });
    expect(h.webUrl).toBeUndefined();
  });
});
