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
    get(_id: string) { return undefined; },
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

    // Turn start — HUD is sent (new UX path; no legacy session-header on attach).
    session.emit({ kind: 'turn_start', turnId: 't1', userInputPreview: 'help', at: 1_000_000 });
    await tick();

    // Tool use
    session.emit({ kind: 'tool_use_start', turnId: 't1', toolUseId: 'u1', toolName: 'Bash', input: { command: 'ls' } });
    await tick();

    // Permission requested via broker
    ctx.pb.push({
      kind: 'pending',
      sessionId: 'sess-a',
      request: {
        id: 'sess-a:p1', category: 'exec', toolName: 'Bash', toolInput: { command: 'ls' },
        resolve: () => { /* noop */ },
      },
    });
    await tick();

    // Broker resolved (external approval via another path; no in-card callback here).
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

    // Assertions (new UX path):
    // At least: HUD send (turn_start) + permission-card send + reply-message send.
    const sends = ctx.adapter.byKind('send');
    expect(sends.length).toBeGreaterThanOrEqual(2);
    // Permission card send: new renderer uses 🔐 Permission prefix.
    expect(sends.some((s) => String(s.args.text ?? '').includes('Permission'))).toBe(true);
    // Reply send contains agent text "Done".
    expect(sends.some((s) => String(s.args.text).includes('Done'))).toBe(true);

    // Cost accumulation: turn_end costUsd surfaced in HUD edit.
    const edits = ctx.adapter.byKind('edit');
    const costShown = edits.some((e) => String(e.args.text ?? '').includes('$0.01'));
    expect(costShown).toBe(true);
  });

  it('outbound call sequence: HUD → permission → reply → HUD-cost-edit (new UX)', async () => {
    const session = new FakeSession({ id: 'sess-seq', workspaceId: 'w1' });
    ctx.sm.push({ kind: 'created', session });
    await tick();

    session.emit({ kind: 'turn_start', turnId: 't1', userInputPreview: 'ls', at: 1_000_000 });
    await tick();

    ctx.pb.push({
      kind: 'pending',
      sessionId: 'sess-seq',
      request: {
        id: 'sess-seq:p1', category: 'file-edit', toolName: 'Edit',
        toolInput: { file_path: 'a.ts' },
        diffPreview: { from: 'old', to: 'new', added: 1, removed: 1, path: 'a.ts' },
        resolve: () => { /* noop */ },
      },
    });
    await tick();

    session.emit({ kind: 'assistant_text', turnId: 't1', text: 'Looking at the code', complete: true });
    session.emit({ kind: 'turn_end', turnId: 't1', durationMs: 200, costUsd: 0.07, tokensIn: 10, tokensOut: 5 });
    await tick();

    const sequence = ctx.adapter.calls.map((c) => ({
      kind: c.kind,
      text: String((c.args as { text?: unknown }).text ?? ''),
    }));

    // First send is the HUD (new UX: <pre><code>📊 turn…).
    expect(sequence[0]!.kind).toBe('send');
    expect(sequence[0]!.text).toMatch(/^<pre><code>📊/);

    // Permission card send uses 🔐 Permission prefix (new PermissionCard).
    const permission = sequence.find((s) => s.kind === 'send' && s.text.includes('Permission'));
    expect(permission).toBeDefined();
    expect(permission!.text).toContain('Edit');

    // Reply send contains the assistant text payload.
    const replyMsg = sequence.find((s) => s.kind === 'send' && s.text.includes('Looking at the'));
    expect(replyMsg).toBeDefined();

    // A HUD edit with the accumulated cost appears after turn_end.
    const costEdit = sequence.find((s) => s.kind === 'edit' && /\$0\.07/.test(s.text));
    expect(costEdit).toBeDefined();
  });
});
