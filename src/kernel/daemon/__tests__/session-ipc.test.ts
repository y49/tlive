// src/kernel/daemon/__tests__/session-ipc.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapDaemon, type DaemonHandle } from '../bootstrap';
import { request, daemonSocketPath } from '../../ipc/client';
import type { SessionMeta } from '../../ipc/protocol';
import type { IMAdapter, OutgoingMessage } from '../../contracts/im-adapter';

const recordingAdapter = (sent: OutgoingMessage[]): IMAdapter => ({
  channel: 'telegram',
  start: async () => {},
  stop: async () => {},
  send: async (o) => { sent.push(o); return { messageId: `m${sent.length}` }; },
  edit: async () => {},
  onInbound: () => {},
  isConnected: () => 'connected',
});

let tmp: string;
let h: DaemonHandle;
let sock: string;

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'tlive-sess-')); sock = daemonSocketPath(tmp); });
afterEach(async () => { await h?.shutdown(); });

const meta: SessionMeta = { id: 's1', label: 'cat @ tmp', cmd: 'cat', cwd: '/tmp', pid: 123, sockPath: '/tmp/s1.sock' };

describe('session.* over IPC', () => {
  it('registers, lists, and unregisters a wrapped session', async () => {
    h = await bootstrapDaemon({ home: tmp });

    const reg = await request({ kind: 'session.register', session: meta }, { socketPath: sock, timeoutMs: 2000 });
    expect(reg.kind).toBe('ack');

    const listed = await request({ kind: 'session.list' }, { socketPath: sock, timeoutMs: 2000 });
    expect(listed.kind).toBe('session.list');
    if (listed.kind === 'session.list') {
      expect(listed.sessions).toHaveLength(1);
      expect(listed.sessions[0].id).toBe('s1');
      expect(listed.sessions[0].sockPath).toBe('/tmp/s1.sock');
    }

    await request({ kind: 'session.unregister', id: 's1' }, { socketPath: sock, timeoutMs: 2000 });
    const after = await request({ kind: 'session.list' }, { socketPath: sock, timeoutMs: 2000 });
    if (after.kind === 'session.list') expect(after.sessions).toHaveLength(0);
  });

  it('exposes the registry on the handle', async () => {
    h = await bootstrapDaemon({ home: tmp });
    h.sessions.register(meta);
    expect(h.sessions.list()).toHaveLength(1);
  });
});

describe('parent-session 清场 must be agent-scoped (backgrounded sub-agent approval survival)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 40));
  // A configured chat keeps requestPermission pending; with no injected imAdapters
  // sendToChat is a no-op (no network), so the pending simply sits in the router.
  // holdSubagents:true — these tests exercise the *held* sub-agent path (the
  // cancel-scoping fix). By default sub-agents pass through (no pending to protect),
  // so remote-hold must be opted in to create a backgrounded sub-agent card at all.
  const writeConfig = () => writeFileSync(join(tmp, 'config.json'), JSON.stringify({
    adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    approvals: { approvalGraceSec: 0, continueGraceSec: 0, continueWindowSec: 30, holdSubagents: true },
  }));
  const fireSubAgentApproval = () =>
    request({ kind: 'hook.permission.request', cwd: '/proj', sessionId: 'parent', toolName: 'Bash', input: { command: 'date' }, agentId: 'subA' },
      { socketPath: sock, timeoutMs: 4000 }).catch(() => undefined);

  it('a parent-session prompt does NOT cancel a backgrounded sub-agent pending approval', async () => {
    writeConfig();
    h = await bootstrapDaemon({ home: tmp });
    const sub = fireSubAgentApproval();
    await tick();
    expect(h.permissionRouter.pendingCount()).toBe(1);

    // The parent (main session, no agent_id) submits a new prompt while the
    // sub-agent is still waiting. The sub-agent's tool call is genuinely pending
    // and has no local answer path — its card must survive.
    await request({ kind: 'hook.event', event: { event: 'prompt', cwd: '/proj', sessionId: 'parent', prompt: 'do something else' } }, { socketPath: sock, timeoutMs: 2000 });
    await tick();
    expect(h.permissionRouter.pendingCount()).toBe(1);

    h.permissionRouter.cancel({ key: 'parent' });
    await sub;
  });

  it("a parent-session prompt STILL cancels the main session's own pending approval (guard against over-scoping)", async () => {
    writeConfig();
    h = await bootstrapDaemon({ home: tmp });
    const main = request({ kind: 'hook.permission.request', cwd: '/proj', sessionId: 'parent', toolName: 'Bash', input: {} },
      { socketPath: sock, timeoutMs: 4000 }).catch(() => undefined); // no agentId = main session
    await tick();
    expect(h.permissionRouter.pendingCount()).toBe(1);

    await request({ kind: 'hook.event', event: { event: 'prompt', cwd: '/proj', sessionId: 'parent', prompt: 'next' } }, { socketPath: sock, timeoutMs: 2000 });
    await tick();
    expect(h.permissionRouter.pendingCount()).toBe(0); // main-session dialog is gone → its card is withdrawn

    await main;
  });

  it('a parent-session Stop does NOT cancel a backgrounded sub-agent pending approval', async () => {
    writeConfig();
    h = await bootstrapDaemon({ home: tmp });
    const sub = fireSubAgentApproval();
    await tick();
    expect(h.permissionRouter.pendingCount()).toBe(1);

    // Stop long-polls (grace + continue window); fire-and-forget — the cancel
    // it performs runs synchronously on arrival, before any waiting.
    const stop = request({ kind: 'hook.continue.request', cwd: '/proj', sessionId: 'parent', context: 'turn ended' }, { socketPath: sock, timeoutMs: 300 }).catch(() => undefined);
    await tick();
    expect(h.permissionRouter.pendingCount()).toBe(1);

    h.permissionRouter.cancel({ key: 'parent' });
    await Promise.all([sub, stop]);
  });

  it('by default (holdSubagents off) a sub-agent approval passes through — no pending, tlive stays transparent', async () => {
    // No holdSubagents in config → default false. A backgrounded sub-agent has no
    // parallel local dialog while a sync hook is held, so holding it would block it
    // with no fallback; instead tlive defers (shim {} → CC-native handling).
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
      approvals: { approvalGraceSec: 0, continueGraceSec: 0, continueWindowSec: 30 },
    }));
    h = await bootstrapDaemon({ home: tmp });
    const res = await request({ kind: 'hook.permission.request', cwd: '/proj', sessionId: 'parent', toolName: 'Bash', input: { command: 'date' }, agentId: 'subA' },
      { socketPath: sock, timeoutMs: 4000 });
    expect(res.kind === 'hook.permission.result' && res.decision).toBe('defer');
    expect(h.permissionRouter.pendingCount()).toBe(0);
  });
});

describe('continuation card has no on-card input box (quote-reply is the entry)', () => {
  it('the "Turn finished" card send carries no inputAction (form box removed)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
      approvals: { continueGraceSec: 0, continueWindowSec: 30 },
    }));
    const sent: OutgoingMessage[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [recordingAdapter(sent)] });

    // Stop long-polls (continue window); fire-and-forget — the card is sent
    // synchronously when continueBroker registers the request, before the wait.
    request({ kind: 'hook.continue.request', cwd: '/proj', sessionId: 'sess', context: 'All green.' }, { socketPath: sock, timeoutMs: 300 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 120));

    const card = sent.find((m) => m.kind === 'card' && (m.title ?? '').includes('Turn finished'));
    expect(card).toBeTruthy();
    expect((card as { inputAction?: unknown }).inputAction).toBeUndefined();
  });
});
