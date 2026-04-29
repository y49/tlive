import { describe, it, expect, beforeEach } from 'vitest';
import { SessionFrontend } from '../../src/im/frontend.js';
import type { PermissionBroker, BrokerListener } from '../../src/permission/broker.js';
import type { ElicitationBroker, ElicitationBrokerListener } from '../../src/permission/elicitation-broker.js';
import type { WorkspaceManager } from '../../src/workspace/manager.js';
import { FakeAdapter } from '../im/fake-adapter.js';
import { FakeSession, mkFakeSessionManager } from '../im/fake-session.js';

function makeFrontend() {
  const adapter = new FakeAdapter('discord');
  const sm = mkFakeSessionManager();
  const pbListeners = new Set<BrokerListener>();
  const pb = {
    subscribe(l: BrokerListener) { pbListeners.add(l); return () => pbListeners.delete(l); },
    push(ev: Parameters<BrokerListener>[0]) { for (const l of pbListeners) l(ev); },
  } as unknown as PermissionBroker & { push: (ev: Parameters<BrokerListener>[0]) => void };
  const ebListeners = new Set<ElicitationBrokerListener>();
  const eb = {
    subscribe(l: ElicitationBrokerListener) { ebListeners.add(l); return () => ebListeners.delete(l); },
    push(ev: Parameters<ElicitationBrokerListener>[0]) { for (const l of ebListeners) l(ev); },
  } as unknown as ElicitationBroker & { push: (ev: Parameters<ElicitationBrokerListener>[0]) => void };
  const wm = {
    partitionBindings(_: string) {
      return {
        primary: { channelType: 'discord' as const, chatId: '100', role: 'primary' as const },
        mirrors: [],
        all: [{ channelType: 'discord' as const, chatId: '100', role: 'primary' as const }],
      };
    },
    get(_: string) { return { name: 'ws', defaults: { model: 'claude' } }; },
  } as unknown as WorkspaceManager;
  const frontend = new SessionFrontend({
    sessionManager: sm,
    workspaceManager: wm,
    permissionBroker: pb,
    elicitationBroker: eb,
    adapters: { discord: adapter },
  });
  frontend.start();
  return { frontend, adapter, sm, pb, eb };
}

async function tick(ms = 10) { await new Promise((r) => setTimeout(r, ms)); }

describe('integration: Discord end-to-end elicitation', () => {
  let ctx: ReturnType<typeof makeFrontend>;
  beforeEach(() => { ctx = makeFrontend(); });

  it('attach → elicitation form → decline → teardown (new UX: todo_write is noop)', async () => {
    // T10b removed the legacy todo-sticky renderer. todo_write events are now
    // surfaced only through the HUD's todoList field (T12 manual smoke covers
    // the full HUD rendering path). This test verifies elicitation still works.
    const session = new FakeSession({ id: 'sess-d', workspaceId: 'w1' });
    ctx.sm.push({ kind: 'created', session });
    await tick();

    // todo_write is no longer rendered as a separate sticky message in new UX.
    // (TODO(T12-smoke): verify todo list appears in HUD card on turn_start)
    session.emit({ kind: 'todo_write', items: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
    ] });
    await tick();

    ctx.eb.push({
      kind: 'pending',
      sessionId: 'sess-d',
      request: {
        id: 'e1', mcpServerName: 'github', mode: 'form',
        description: 'Provide credentials',
        schema: { token: { type: 'string', required: true } },
        resolve: () => { /* noop */ },
      },
    });
    await tick();

    ctx.eb.push({
      kind: 'resolved',
      sessionId: 'sess-d', requestId: 'e1',
      result: { action: 'decline' },
    });
    await tick();

    // Elicitation form still sends a message and edits it on resolution.
    const sends = ctx.adapter.byKind('send');
    expect(sends.some((s) => String(s.args.text ?? '').includes('github'))).toBe(true);
    const edits = ctx.adapter.byKind('edit');
    expect(edits.some((e) => String(e.args.text ?? '').includes('Declined'))).toBe(true);
  });
});
