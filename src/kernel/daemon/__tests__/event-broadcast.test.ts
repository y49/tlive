import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { bootstrapDaemon, type DaemonHandle } from '../bootstrap.js';
import { request } from '../../ipc/client.js';
import type { IMAdapter, IMChannel, OutgoingMessage, IncomingEnvelope } from '../../contracts/im-adapter.js';

let tmp: string;
let h: DaemonHandle;
let sock: string;
const sockets: WebSocket[] = [];

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'tlive-evt-')); sock = join(tmp, 'daemon.sock'); });
afterEach(async () => { for (const ws of sockets.splice(0)) ws.close(); await h?.shutdown(); });

function makeFakeAdapter(channel: IMChannel): IMAdapter {
  return {
    channel,
    async start() { /* noop */ },
    async stop() { /* noop */ },
    async send(_out: OutgoingMessage) { return { messageId: 'm1' }; },
    async edit() { /* noop */ },
    onInbound(_handler: (e: IncomingEnvelope) => void) { /* noop */ },
    isConnected() { return 'connected'; },
  };
}

async function openEvents(): Promise<Array<Record<string, any>>> {
  const url = new URL(h.webUrl!);
  const frames: Array<Record<string, any>> = [];
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://${url.host}/ws/events?token=${url.searchParams.get('token')}`);
    sockets.push(ws);
    ws.on('message', (d: Buffer) => frames.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  return frames;
}

async function waitFor(frames: Array<Record<string, any>>, pred: (f: Record<string, any>) => boolean, ms = 4000): Promise<Record<string, any>> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const f = frames.find(pred);
    if (f) return f;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('frame not seen: ' + JSON.stringify(frames));
}

describe('daemon → /ws/events downstream broadcast', () => {
  it('broadcasts a hook.event activity and reflects it in /api/sessions', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 } }));
    h = await bootstrapDaemon({ home: tmp });
    const frames = await openEvents();
    await request({ kind: 'hook.event', event: { event: 'activity', cwd: '/repo/a', sessionId: 's', toolName: 'Bash', result: {} } }, { socketPath: sock, timeoutMs: 2000 });
    const f = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === '/repo/a');
    expect(f.session.status).toBe('active');
    const url = new URL(h.webUrl!);
    const api = await fetch(`${url.origin}/api/sessions${url.search}`);
    const arr = (await api.json()) as Array<Record<string, any>>;
    expect(arr.find((s) => s.id === '/repo/a')?.status).toBe('active');
  });

  it('broadcasts session.register (upsert) and session.unregister (remove)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 } }));
    h = await bootstrapDaemon({ home: tmp });
    const frames = await openEvents();
    await request({ kind: 'session.register', session: { id: 'u1', label: 'l', cmd: 'claude', cwd: '/repo/b', pid: 1, sockPath: '/s.sock' } }, { socketPath: sock, timeoutMs: 2000 });
    const up = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === '/repo/b');
    expect(up.session.kind).toBe('wrapped');
    await request({ kind: 'session.unregister', id: 'u1' }, { socketPath: sock, timeoutMs: 2000 });
    const rm = await waitFor(frames, (x) => x.type === 'session-remove' && x.id === '/repo/b');
    expect(rm).toBeTruthy();
  });

  it('sets registry.pending on approval-ask and clears it on answer', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 }, adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } } }));
    h = await bootstrapDaemon({ home: tmp, imAdapters: [makeFakeAdapter('telegram')] });
    const frames = await openEvents();
    // fire the blocking permission request in the background
    const p = request({ kind: 'hook.permission.request', cwd: '/repo/c', sessionId: 's', toolName: 'Bash', input: { command: 'ls' } }, { socketPath: sock, timeoutMs: 5000 });
    const ask = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === '/repo/c' && x.session.status === 'waiting-approval');
    expect(ask.session.pending?.title).toContain('Bash');
    const reqId = ask.session.pending.requestId as string;
    await request({ kind: 'hook.permission.answer', requestId: reqId, approved: true }, { socketPath: sock, timeoutMs: 2000 });
    await p;
    const cleared = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === '/repo/c' && x.session.status === 'active');
    expect(cleared.session.pending).toBeUndefined();
  });
});
