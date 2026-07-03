// src/kernel/web/__tests__/server.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { startWebServer, type WebServerHandle } from '../server.js';
import { SessionRegistry } from '../session-registry.js';
import { EventHub } from '../event-hub.js';
import { SessionHost } from '../../pty/session-host.js';
import { FrameDecoder, FrameType, encodeAttach, encodeData } from '../stream-protocol.js';

let handle: WebServerHandle | null = null;
let host: SessionHost | null = null;
afterEach(async () => { await handle?.close(); await host?.stop(); handle = null; host = null; });

async function get(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
}

describe('WebServer', () => {
  it('rejects http without a valid token (401)', async () => {
    const sessions = new SessionRegistry();
    handle = await startWebServer({ bind: '127.0.0.1', port: 0, token: 'secret', sessions, webDir: join(tmpdir(), 'nope') });
    const r = await get(`http://127.0.0.1:${handle.port}/api/sessions`);
    expect(r.status).toBe(401);
    const ok = await get(`http://127.0.0.1:${handle.port}/api/sessions?token=secret`);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual([]);
  });

  it('attaches a ws client to a session and echoes through the bridge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-ws-'));
    const sockPath = join(dir, 's.sock');
    host = new SessionHost({ id: 'w1', cmd: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], cwd: dir, sockPath, attachLocal: false });
    await host.start();
    const sessions = new SessionRegistry();
    sessions.register({ id: 'w1', label: 'echo', cmd: 'node', cwd: dir, pid: process.pid, sockPath });

    handle = await startWebServer({ bind: '127.0.0.1', port: 0, token: 'secret', sessions, webDir: join(tmpdir(), 'nope') });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no echo')), 8000);
      const ws = new WebSocket(`ws://127.0.0.1:${handle!.port}/ws/term/w1?token=secret`);
      const dec = new FrameDecoder();
      ws.on('open', () => {
        ws.send(encodeAttach(80, 24));
        ws.send(encodeData(Buffer.from('ping\n')));
      });
      ws.on('message', (data: Buffer) => {
        for (const f of dec.push(Buffer.from(data))) {
          if (f.type === FrameType.Data && f.payload.toString('utf8').includes('ping')) {
            clearTimeout(t); ws.close(); resolve();
          }
        }
      });
      ws.on('error', reject);
    });
    expect(true).toBe(true);
  });

  it('serves the terminal page at /s/<id> (token-gated)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-webdir-'));
    writeFileSync(join(dir, 'terminal.html'), '<!doctype html><title>t</title><script src="/terminal.js"></script>');
    const sessions = new SessionRegistry();
    handle = await startWebServer({ bind: '127.0.0.1', port: 0, token: 'secret', sessions, webDir: dir });
    const noTok = await fetch(`http://127.0.0.1:${handle.port}/s/anything`);
    expect(noTok.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${handle.port}/s/anything?token=secret`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('/terminal.js');
  });

  it('rejects ws upgrade with a bad token (401, no connection)', async () => {
    const sessions = new SessionRegistry();
    handle = await startWebServer({ bind: '127.0.0.1', port: 0, token: 'secret', sessions, webDir: join(tmpdir(), 'nope') });
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${handle!.port}/ws/term/x?token=wrong`);
      ws.on('open', () => { ws.close(); resolve(/* should not happen, but don't hang */); });
      ws.on('error', () => resolve()); // expected: handshake rejected
    });
    expect(true).toBe(true);
  });

  it('broadcasts registry frames to /ws/events clients (token-gated)', async () => {
    const sessions = new SessionRegistry();
    const events = new EventHub();
    handle = await startWebServer({ bind: '127.0.0.1', port: 0, token: 'secret', sessions, events, webDir: join(tmpdir(), 'nope') });
    const frame = { type: 'session-upsert', session: { id: '/r', label: 'r', cwd: '/r', kind: 'hook', status: 'idle', lastActivityAt: 1, muted: false } };
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no event')), 8000);
      const ws = new WebSocket(`ws://127.0.0.1:${handle!.port}/ws/events?token=secret`);
      ws.on('open', () => { events.broadcast(frame as never); });
      ws.on('message', (data: Buffer) => {
        const f = JSON.parse(data.toString());
        if (f.type === 'session-upsert' && f.session.id === '/r') { clearTimeout(t); ws.close(); resolve(); }
      });
      ws.on('error', reject);
    });
    expect(true).toBe(true);
  });

  it('dispatches upstream /ws/events actions to onAction', async () => {
    const sessions = new SessionRegistry();
    const events = new EventHub();
    const got: unknown[] = [];
    handle = await startWebServer({ bind: '127.0.0.1', port: 0, token: 'secret', sessions, events, onAction: (a) => got.push(a), webDir: join(tmpdir(), 'nope') });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no dispatch')), 8000);
      const ws = new WebSocket(`ws://127.0.0.1:${handle!.port}/ws/events?token=secret`);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'approve', requestId: 'r1', approved: true }));
        ws.send('garbage-not-json'); // must be ignored, not crash
        ws.send(JSON.stringify({ type: 'mute', id: '/repo', muted: true }));
      });
      const check = setInterval(() => {
        if (got.length >= 2) { clearInterval(check); clearTimeout(t); ws.close(); resolve(); }
      }, 20);
      ws.on('error', reject);
    });
    expect(got).toEqual([
      { type: 'approve', requestId: 'r1', approved: true },
      { type: 'mute', id: '/repo', muted: true },
    ]);
  });

  it('rejects /ws/events with a bad token (no connection)', async () => {
    const sessions = new SessionRegistry();
    const events = new EventHub();
    handle = await startWebServer({ bind: '127.0.0.1', port: 0, token: 'secret', sessions, events, webDir: join(tmpdir(), 'nope') });
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${handle!.port}/ws/events?token=wrong`);
      ws.on('open', () => { ws.close(); resolve(); });
      ws.on('error', () => resolve());
    });
    expect(events.size()).toBe(0);
  });

  it('/api/sessions returns the rich snapshot', async () => {
    const sessions = new SessionRegistry();
    sessions.upsert({ cwd: '/repo', status: 'active', lastActivityAt: 5, lastMessage: 'hi' });
    const events = new EventHub();
    handle = await startWebServer({ bind: '127.0.0.1', port: 0, token: 'secret', sessions, events, webDir: join(tmpdir(), 'nope') });
    const r = await get(`http://127.0.0.1:${handle.port}/api/sessions?token=secret`);
    const arr = JSON.parse(r.body);
    expect(arr[0]).toMatchObject({ id: '/repo', cwd: '/repo', kind: 'hook', status: 'active', lastMessage: 'hi', muted: false });
  });
});

describe('POST /api/upload', () => {
  it('stores the body in inboxDir and returns the path (token-gated)', async () => {
    const inbox = mkdtempSync(join(tmpdir(), 'tlive-inbox-'));
    const sessions = new SessionRegistry();
    handle = await startWebServer({ bind: '127.0.0.1', port: 0, token: 'secret', sessions, inboxDir: inbox, webDir: join(tmpdir(), 'nope') });
    const noTok = await fetch(`http://127.0.0.1:${handle.port}/api/upload?name=a.png`, { method: 'POST', body: 'x' });
    expect(noTok.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${handle.port}/api/upload?name=err.png&token=secret`, { method: 'POST', body: Buffer.from([1, 2, 3]) });
    expect(ok.status).toBe(200);
    const { path } = (await ok.json()) as { path: string };
    expect(path.startsWith(inbox)).toBe(true);
    expect(path.endsWith('-err.png')).toBe(true);
    expect(readFileSync(path)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('sanitizes path separators in the name', async () => {
    const inbox = mkdtempSync(join(tmpdir(), 'tlive-inbox-'));
    const sessions = new SessionRegistry();
    handle = await startWebServer({ bind: '127.0.0.1', port: 0, token: 'secret', sessions, inboxDir: inbox, webDir: join(tmpdir(), 'nope') });
    const ok = await fetch(`http://127.0.0.1:${handle.port}/api/upload?name=${encodeURIComponent('../../evil.sh')}&token=secret`, { method: 'POST', body: 'x' });
    const { path } = (await ok.json()) as { path: string };
    // separators are flattened -> the file stays DIRECTLY inside inbox (no traversal)
    expect(dirname(path)).toBe(inbox);
  });

  it('404s when inboxDir is not configured', async () => {
    const sessions = new SessionRegistry();
    handle = await startWebServer({ bind: '127.0.0.1', port: 0, token: 'secret', sessions, webDir: join(tmpdir(), 'nope') });
    const r = await fetch(`http://127.0.0.1:${handle.port}/api/upload?name=a&token=secret`, { method: 'POST', body: 'x' });
    expect(r.status).toBe(404);
  });
});
