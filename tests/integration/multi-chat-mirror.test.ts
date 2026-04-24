// tests/integration/multi-chat-mirror.test.ts
//
// Integration-level regression for the primary/mirror fan-out contract:
//   - Bind a workspace to two chats: Telegram (primary) + Discord (mirror).
//   - Create a real LocalSession.
//   - Drive a turn + a permission request.
//   - Assert each adapter receives exactly one call per event with its OWN
//     chatId (no cross-wiring); mirror's permission card has no buttons.
//
// This complements tests/im/multi-binding.test.ts (which uses mocked
// SessionManager/PermissionBroker). Here we wire real classes end-to-end
// to catch bootstrap regressions.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionManager } from '../../src/session/manager.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { WorkspaceManager } from '../../src/workspace/manager.js';
import { PermissionBroker } from '../../src/permission/broker.js';
import { SessionFrontend } from '../../src/im/frontend.js';
import { FakeAdapter } from '../im/fake-adapter.js';
import { FakeRuntime } from '../session/fake-runtime.js';

async function tick(ms = 10): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }

async function boot() {
  const home = mkdtempSync(join(tmpdir(), 'tlive-mirror-'));
  const persistence = new SessionPersistence(join(home, 'sessions'));
  await persistence.init();
  const broker = new PermissionBroker();
  const runtimes: FakeRuntime[] = [];
  const mgr = new SessionManager({
    persistence,
    broker,
    runtimeFactory: () => { const r = new FakeRuntime('claude'); runtimes.push(r); return r; },
  });

  const workspaces = new WorkspaceManager({ persistPath: join(home, 'workspaces.json') });
  const ws = workspaces.create({ name: 'mirrored', workdir: home });
  workspaces.addBinding(ws.id, { channelType: 'telegram', chatId: 'tg-1', role: 'primary' });
  workspaces.addBinding(ws.id, { channelType: 'discord', chatId: 'ds-1', role: 'mirror' });

  const tg = new FakeAdapter('telegram');
  const ds = new FakeAdapter('discord');
  const frontend = new SessionFrontend({
    sessionManager: mgr,
    workspaceManager: workspaces,
    permissionBroker: broker,
    adapters: { telegram: tg, discord: ds },
  });
  frontend.start();

  return { home, mgr, broker, workspaces, ws, frontend, tg, ds, runtimes };
}

describe('integration: multi-chat-mirror', () => {
  let env: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => { env = await boot(); });
  afterEach(async () => {
    await env.frontend.stop();
    await env.mgr.stopAll().catch(() => undefined);
    rmSync(env.home, { recursive: true, force: true });
  });

  it('primary and mirror each receive their own chatId; mirror permission card has no buttons', async () => {
    const session = await env.mgr.createLocal({
      workspaceId: env.ws.id,
      provider: 'claude',
      workdir: env.home,
      source: 'im',
    });
    await tick();

    // Session header went to both adapters with their respective chatIds.
    const tgSends = env.tg.byKind('send');
    const dsSends = env.ds.byKind('send');
    expect(tgSends.length).toBeGreaterThan(0);
    expect(dsSends.length).toBeGreaterThan(0);
    for (const c of env.tg.calls) {
      const cid = (c.args as { chatId?: string }).chatId;
      if (cid) expect(cid).toBe('tg-1');
    }
    for (const c of env.ds.calls) {
      const cid = (c.args as { chatId?: string }).chatId;
      if (cid) expect(cid).toBe('ds-1');
    }

    // Issue a permission request via the runtime and flush.
    const runtime = env.runtimes[0]!;
    runtime.emitPermission({
      id: `${session.id}:perm-mirror`,
      category: 'generic',
      toolName: 'Write',
      toolInput: { path: 'a.ts' },
      resolve: () => undefined,
    });
    await tick();

    const tgPerms = env.tg.byKind('send').filter((c) => /Permission/i.test(String((c.args as { text?: string }).text ?? '')));
    const dsPerms = env.ds.byKind('send').filter((c) => /Permission/i.test(String((c.args as { text?: string }).text ?? '')));
    expect(tgPerms.length).toBe(1);
    expect(dsPerms.length).toBe(1);

    // Primary has buttons; mirror does not.
    const tgMarkup = (tgPerms[0]!.args as { replyMarkup?: { buttons?: unknown[][] } }).replyMarkup;
    expect(tgMarkup?.buttons?.length ?? 0).toBeGreaterThan(0);
    expect((dsPerms[0]!.args as { replyMarkup?: unknown }).replyMarkup).toBeUndefined();
  });
});
