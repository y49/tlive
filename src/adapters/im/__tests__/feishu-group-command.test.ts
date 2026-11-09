import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same SDK mock shape as feishu.test.ts: the adapter's handlers are captured
// from EventDispatcher.register() so a test can feed a real wire payload in.
const capturedHandlers: Record<string, (data: unknown) => Promise<unknown>> = {};

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { im = { v1: { message: { create: vi.fn(async () => ({ data: { message_id: 'fmid-1' } })), patch: vi.fn() } } }; },
  WSClient: class {
    start = vi.fn(); close = vi.fn();
  },
  EventDispatcher: class {
    register(h: Record<string, (data: unknown) => Promise<unknown>>) {
      Object.assign(capturedHandlers, h);
    }
  },
}));

import { FeishuAdapter } from '../feishu.js';
import { InboundHandler, type InboundHandlerDeps } from '../../../kernel/daemon/inbound-handler.js';
import { SenderGuard } from '../../../kernel/daemon/sender-guard.js';
import { AskFlow } from '../../../kernel/daemon/ask-flow.js';
import type { IncomingEnvelope, OutgoingMessage } from '../../../kernel/contracts/im-adapter.js';
import type { PermissionRouter } from '../../../kernel/daemon/permission-router.js';
import type { ContinueBroker } from '../../../kernel/permission/continue-broker.js';

// End-to-end coverage for #104 / #105, at the seam feishu.test.ts cannot reach.
//
// Those tests pin what the adapter emits ("the text is `/help`"). This file pins
// the composition: a real FeishuAdapter wired into a real InboundHandler, so the
// cases assert what happens to the text AFTER the strip — `/mode all` reaching
// setMode with its argument intact, bare text reaching a wrapped pty, and a
// quoted deny reason reaching the agent. It deliberately does not re-assert the
// stripping rules themselves; those live in feishu.test.ts so each behaviour has
// one home.
//
// Wire shape is the one from the issue's `im.message.receive_v1` sample:
//   { "message": { "content": "{\"text\":\"@_user_1 /help\"}", "chat_type": "group" },
//     "mentions": [{ "key": "@_user_1", "name": "tlive", ... }] }
// Feishu's @ is a PLACEHOLDER token, and `mentions[].key` is the same string.

const GROUP = 'oc_group';

/** A real adapter whose inbound is wired to a real InboundHandler — the same
 *  wiring bootstrap.ts does (`a.onInbound(env => inbound.handle(env))`). */
async function wire(deps: Partial<InboundHandlerDeps> = {}) {
  const sent: OutgoingMessage[] = [];
  let handler: InboundHandler | undefined;
  const base: InboundHandlerDeps = {
    senderGuard: new SenderGuard([]),
    imBy: () => ({
      channel: 'feishu' as const,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(async (m: OutgoingMessage) => { sent.push(m); return { messageId: 'r1' }; }),
      edit: vi.fn().mockResolvedValue(undefined),
      onInbound: vi.fn(),
      isConnected: vi.fn().mockReturnValue('connected' as const),
    }),
    permissionRouter: { answer: vi.fn(), requestPermission: vi.fn() } as unknown as PermissionRouter,
    continueBroker: { answer: vi.fn().mockReturnValue(false), request: vi.fn(), onRequest: vi.fn() } as unknown as ContinueBroker,
    takeLatestContinueId: () => null,
    setMuted: vi.fn(),
    setTrust: vi.fn(),
    setAutoApprove: vi.fn(),
    getMode: () => 'full' as const,
    setMode: vi.fn(),
    heldSubagentCount: () => 0,
    addAllowTool: vi.fn(),
    resolveReply: () => undefined,
    sessionInfo: () => undefined,
    listSessions: () => [],
    inject: vi.fn().mockResolvedValue(undefined),
    findLiveCard: () => null,
    askFlow: new AskFlow(),
    repaintAsk: vi.fn(),
    ...deps,
  };
  handler = new InboundHandler(base);

  const adapter = new FeishuAdapter({ appId: 'A', appSecret: 'S', chatId: GROUP });
  await adapter.start();
  // The adapter does not await its inbound handler, and neither does bootstrap
  // (`onInbound(env => void inbound.handle(env))`), so keep the promise ourselves
  // and await it before asserting, or every case below races the reply.
  let inflight: Promise<void> = Promise.resolve();
  adapter.onInbound((env: IncomingEnvelope) => {
    inflight = handler!.handle(env);
  });

  /** Feed one raw `im.message.receive_v1` payload and let the handler settle. */
  const receive = async (text: string, over: Record<string, unknown> = {}): Promise<void> => {
    await capturedHandlers['im.message.receive_v1']({
      sender: { sender_id: { open_id: 'ou_me' } },
      message: {
        message_id: 'om_1',
        chat_id: GROUP,
        content: JSON.stringify({ text }),
        create_time: '1700000000000',
        ...over,
      },
      mentions: [{ key: '@_user_1', name: 'tlive', id: { open_id: 'ou_bot' } }],
    });
    await inflight;
  };

  return { base, sent, receive, adapter };
}

const texts = (sent: OutgoingMessage[]): string[] =>
  sent.map((m) => (m.kind === 'text' ? m.text : m.kind === 'card' ? m.body : ''));

/** The bare-text fallback is the bug's fingerprint — it is what a user saw in
 *  the group instead of their command running. Asserting its absence is the
 *  point of every test below. */
const FALLBACK = 'no active session can take text';

describe('Feishu group @mention → command layer (regression: #104 / #105)', () => {
  beforeEach(() => {
    for (const k of Object.keys(capturedHandlers)) delete capturedHandlers[k];
  });

  // #104's headline symptom, end to end. Pre-fix the handler received
  // "@_user_1 /help", parseImCommand returned null (it requires a leading
  // '/'), and the reply was the bare-text fallback.
  it('a group "@bot /help" answers with the commands card, not the bare-text fallback', async () => {
    const { sent, receive } = await wire();
    await receive('@_user_1 /help');
    expect(texts(sent).join('\n')).not.toContain(FALLBACK);
    expect(sent).toHaveLength(1);
    const card = sent[0] as { kind: string; title?: string };
    expect(card.kind).toBe('card');
    expect(card.title).toContain('commands');
  });

  // Commands carry an argument; the strip must not eat it. `/mode all` is the
  // one that persists a posture, so a silently dropped arg is a visible state
  // change, not just a wrong reply.
  it('a group "@bot /mode all" reaches the posture setter with its argument intact', async () => {
    const setMode = vi.fn();
    const { receive, sent } = await wire({ setMode });
    await receive('@_user_1 /mode all');
    expect(setMode).toHaveBeenCalledWith('all');
    expect(texts(sent).join('\n')).not.toContain(FALLBACK);
  });

  // Two placeholders, `@_all` for a whole-group mention: the loop in
  // stripLeadingMentions must consume all leading tokens, not just the first.
  it('several leading mentions (including @_all) still resolve the command', async () => {
    const setMuted = vi.fn();
    const { receive, sent } = await wire({ setMuted });
    await receive('@_all @_user_1 @_user_2 /mute on');
    expect(setMuted).toHaveBeenCalledWith(true);
    expect(sent).toHaveLength(1);
  });

  // The second leak #104 named: with exactly one wrapped session, bare text is
  // injected into that pty. Pre-fix the agent read "@_user_1 看看这个".
  it('bare text injected into a wrapped pty carries no mention token', async () => {
    const inject = vi.fn().mockResolvedValue(undefined);
    const { receive } = await wire({
      inject,
      listSessions: () => [{ cwd: '/repo', kind: 'wrapped' as const, label: 'claude @ repo', sockPath: '/s.sock' }],
    });
    await receive('@_user_1 看看这个');
    expect(inject).toHaveBeenCalledWith('/s.sock', '看看这个');
  });

  // The third leak: text quoted onto a live approval card becomes the denial
  // reason and is forwarded verbatim into the agent's conversation.
  it('a quoted deny reason reaches the agent without the mention token', async () => {
    const reasons: Array<string | undefined> = [];
    const { receive } = await wire({
      findLiveCard: () => 'req-1',
      permissionRouter: {
        answer: (_rid: string, _approved: boolean, message?: string) => { reasons.push(message); return true; },
        requestPermission: vi.fn(),
      } as unknown as PermissionRouter,
    });
    await receive('@_user_1 别用 rm -rf', { parent_id: 'om_card' });
    expect(reasons).toEqual(['别用 rm -rf']);
  });

});
