import { describe, it, expect, beforeEach } from 'vitest';
import { SessionFrontend } from '../../src/im/frontend.js';
import type { SessionManager, ManagerEventListener } from '../../src/session/manager.js';
import type { PermissionBroker, BrokerListener } from '../../src/permission/broker.js';
import type { ElicitationBroker, ElicitationBrokerListener } from '../../src/permission/elicitation-broker.js';
import type { WorkspaceManager } from '../../src/workspace/manager.js';
import { FakeAdapter } from '../im/fake-adapter.js';
import { FakeSession } from '../im/fake-session.js';

function makeFrontend(channel: 'telegram' | 'discord' | 'feishu') {
  const adapter = new FakeAdapter(channel);
  const smListeners = new Set<ManagerEventListener>();
  const sm = {
    subscribe(l: ManagerEventListener) { smListeners.add(l); return () => smListeners.delete(l); },
    push(ev: Parameters<ManagerEventListener>[0]) { for (const l of smListeners) l(ev); },
  } as unknown as SessionManager & { push: (ev: Parameters<ManagerEventListener>[0]) => void };
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
        primary: { channelType: channel, chatId: '100', role: 'primary' },
        mirrors: [],
        all: [{ channelType: channel, chatId: '100', role: 'primary' }],
      };
    },
    get(_: string) { return { name: 'ws', defaults: { model: 'claude' } }; },
  } as unknown as WorkspaceManager;
  const frontend = new SessionFrontend({
    sessionManager: sm,
    workspaceManager: wm,
    permissionBroker: pb,
    elicitationBroker: eb,
    adapters: { [channel]: adapter } as Record<string, FakeAdapter>,
  });
  frontend.start();
  return { frontend, adapter, sm, pb, eb };
}

async function tick(ms = 10) { await new Promise((r) => setTimeout(r, ms)); }

describe('integration: Telegram end-to-end turn', () => {
  let ctx: ReturnType<typeof makeFrontend>;
  beforeEach(() => { ctx = makeFrontend('telegram'); });

  it('attach → turn_start → tool_use → permission → approve → assistant_text → session_complete', async () => {
    const session = new FakeSession({ id: 'sess-a', workspaceId: 'w1' });
    ctx.sm.push({ kind: 'created', session });
    await tick();

    // Turn start
    session.emit({ kind: 'turn_start', turnId: 't1', userInputPreview: 'help', at: 1_000_000 });
    await tick();

    // Tool use
    session.emit({ kind: 'tool_use_start', turnId: 't1', toolUseId: 'u1', toolName: 'Bash', input: { command: 'ls' } });
    await tick();

    // Permission requested via broker
    let approved = false;
    ctx.pb.push({
      kind: 'pending',
      sessionId: 'sess-a',
      request: {
        id: 'sess-a:p1', category: 'exec', toolName: 'Bash', toolInput: { command: 'ls' },
        resolve: () => { approved = true; },
      },
    });
    await tick();

    // Approve (simulate callback → broker.resolve)
    ctx.pb.push({
      kind: 'resolved',
      sessionId: 'sess-a', requestId: 'sess-a:p1', decision: 'allow',
    });
    await tick();

    // Tool result + assistant text
    session.emit({
      kind: 'tool_use_result', toolUseId: 'u1', output: 'ok', durationMs: 10, ok: true,
    });
    await tick();
    session.emit({ kind: 'assistant_text', turnId: 't1', text: 'Done', complete: true });
    session.emit({ kind: 'turn_end', turnId: 't1', durationMs: 100, costUsd: 0.01, tokensIn: 10, tokensOut: 5 });
    await tick();
    session.emit({ kind: 'session_complete', reason: 'ok', summary: 'done' });
    await tick();

    // Assertions:
    // At least: session-header send, activity-sticky send, permission-card send, agent-message send.
    const sends = ctx.adapter.byKind('send');
    expect(sends.length).toBeGreaterThanOrEqual(4);
    // Permission card must have been edited to "Allowed" banner.
    const edits = ctx.adapter.byKind('edit');
    const allowed = edits.some((e) => String(e.args.text).includes('Allowed'));
    expect(allowed).toBe(true);
    // Agent message text "Done" rendered.
    expect(sends.some((s) => String(s.args.text).includes('Done'))).toBe(true);
    // Approval callback was invoked in our broker mock indirectly; broker side is T4's test.
    expect(approved).toBe(false); // our mock broker doesn't call request.resolve, that's fine.
  });
});
