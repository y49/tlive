// tests/integration/multi-chat-mirror.test.ts
//
// Integration-level regression for the primary/mirror fan-out contract:
//   - Bind a workspace to two chats: Telegram (primary) + Feishu (mirror).
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
  workspaces.addBinding(ws.id, { channelType: 'telegram', chatId: 'tg-1' });
  workspaces.addBinding(ws.id, { channelType: 'feishu', chatId: 'fs-1' });

  const tg = new FakeAdapter('telegram');
  const ds = new FakeAdapter('feishu');
  const frontend = new SessionFrontend({
    sessionManager: mgr,
    workspaceManager: workspaces,
    permissionBroker: broker,
    adapters: { telegram: tg, feishu: ds },
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

  it('primary gets permission card with buttons; mirror gets nothing (new UX)', async () => {
    // T10b removed legacy session-header and mirror-tail renderers. In the new UX
    // no messages are sent on session attach; only turn_start (HUD) triggers outbound.
    // (TODO(T12-smoke): verify HUD sends on turn_start for multi-binding scenario)
    const session = await env.mgr.createLocal({
      workspaceId: env.ws.id,
      provider: 'claude',
      workdir: env.home,
      source: 'im',
      ownerChat: { channelType: 'telegram', chatId: 'tg-1' },
    });
    await tick();

    // No sends on attach in new UX (no legacy session-header renderer).
    expect(env.tg.byKind('send').length).toBe(0);
    expect(env.ds.byKind('send').length).toBe(0);

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

    // Primary (Telegram tg-1) receives the permission card with buttons.
    const tgPerms = env.tg.byKind('send').filter((c) => /Permission/i.test(String((c.args as { text?: string }).text ?? '')));
    expect(tgPerms.length).toBe(1);
    const tgMarkup = (tgPerms[0]!.args as { replyMarkup?: { buttons?: unknown[][] } }).replyMarkup;
    expect(tgMarkup?.buttons?.length ?? 0).toBeGreaterThan(0);
    expect((tgPerms[0]!.args as { chatId?: string }).chatId).toBe('tg-1');

    // Mirror (Feishu fs-1) receives no permission card in new UX
    // (legacy mirror-tail renderer was deleted in T10b).
    const dsPerms = env.ds.byKind('send').filter((c) => /Permission/i.test(String((c.args as { text?: string }).text ?? '')));
    expect(dsPerms.length).toBe(0);

    void session; // suppress unused-var lint
  });
});
