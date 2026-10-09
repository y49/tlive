import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapDaemon, type DaemonHandle } from '../bootstrap.js';
import { request, daemonSocketPath } from '../../ipc/client.js';
import type { IMAdapter, IncomingEnvelope, OutgoingMessage } from '../../contracts/im-adapter.js';

const { injectInput } = vi.hoisted(() => ({ injectInput: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../inject.js', () => ({ injectInput }));
let h: DaemonHandle | undefined, home: string;
afterEach(async () => { await h?.shutdown(); h = undefined; if (home) rmSync(home, { recursive: true, force: true }); vi.clearAllMocks(); });

async function setup(graceSec = 0) {
  home = mkdtempSync(join(tmpdir(), 'tlive-retry-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    web: { enabled: false }, approvals: {continueGraceSec: graceSec},
    adapters: {feishu: {appId: 'test', appSecret: 'test', chatId: 'c1'}},
  }));
  const sent: OutgoingMessage[] = [];
  let inbound: (env: IncomingEnvelope) => void = () => {};
  const adapter: IMAdapter = {channel: 'feishu', start: async () => {}, stop: async () => {},
    send: async msg => {sent.push(msg); return {messageId: `m${sent.length}`}}, edit: async () => {},
    onInbound: handler => {inbound = handler}, isConnected: () => 'connected'};
  h = await bootstrapDaemon({home, imAdapters: [adapter], desktopNotifier: {notify: async () => {}}});
  return {sent, fire: (text: string) => inbound({channel: 'feishu', chatId: 'c1', userId: 'u1', messageId: 'reply', text, ts: Date.now()}), sock: daemonSocketPath(home)};
}

describe('session error recovery wiring', () => {
  it('does not recreate failed-turn recovery after successful completion during error grace', async () => {
    const {sock, sent} = await setup(0.05);
    await request({kind: 'hook.notify', cwd: '/plain', sessionId: 'plain', level: 'error',
      message: 'session error: overloaded', sessionError: {text: 'overloaded', transient: true}}, {socketPath: sock});
    const pending = request({kind: 'hook.continue.request', cwd: '/plain', sessionId: 'plain', context: 'done', lastMessage: 'done'}, {socketPath: sock, timeoutMs: 2000});
    pending.catch(() => {});
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].kind).toBe('card');
    expect(JSON.stringify(sent[0])).not.toContain('session error');
    await h!.shutdown(); h = undefined;
    await pending;
  });
  it('gives plain Claude sessions concrete terminal recovery instructions', async () => {
    const {sock, sent} = await setup();
    await request({kind: 'hook.notify', cwd: '/plain', sessionId: 'plain', level: 'error',
      message: 'session error: server_error', sessionError: {text: 'server_error', transient: true}}, {socketPath: sock});
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(JSON.stringify(sent[0])).toContain('tlive run');
    expect(JSON.stringify(sent[0])).not.toContain('retry:');
  });

  it('routes one retry click to the selected wrapped project, and rejects duplicate clicks', async () => {
    const {sock, sent, fire} = await setup();
    for (const id of ['one', 'two']) {
      await request({kind: 'session.register', session: {id, label: id, cwd: `/${id}`, cmd: 'claude', pid: process.pid, sockPath: `/test-${id}.sock`}}, {socketPath: sock});
      await request({kind: 'hook.notify', cwd: `/${id}`, sessionId: id, wrappedId: id, level: 'error',
        message: 'session error: overloaded', sessionError: {text: 'overloaded', transient: true}}, {socketPath: sock});
    }
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const one = sent.find(m => m.kind === 'card' && m.title?.includes('one'));
    expect(one?.kind).toBe('card');
    const button = one?.kind === 'card' ? one.buttons?.find(b => b.id.startsWith('retry:')) : undefined;
    expect(button).toBeDefined();
    await request({kind: 'hook.notify', cwd: '/one', sessionId: 'one', wrappedId: 'one', level: 'error',
      message: 'session error: overloaded', sessionError: {text: 'overloaded', transient: true}}, {socketPath: sock});
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(sent).toHaveLength(2);
    fire(button!.id);
    await vi.waitFor(() => expect(injectInput).toHaveBeenCalledTimes(1));
    expect(injectInput.mock.calls[0][0]).toBe('/test-one.sock');
    fire(button!.id);
    await vi.waitFor(() => expect(sent.some(m => m.kind === 'text' && m.text.includes('no longer active'))).toBe(true));
    expect(injectInput).toHaveBeenCalledTimes(1);
  });
});
