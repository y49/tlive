import { describe, it, expect } from 'vitest';
import { ElicitationFormRenderer, buildElicitationMarkup } from '../../../src/im/render/elicitation-form.js';
import { CAPABILITIES } from '../../../src/im/capability-matrix.js';
import { newSessionRenderState } from '../../../src/im/render/types.js';
import { FakeAdapter } from '../fake-adapter.js';
import type { ElicitationRequest } from '../../../src/runtime/types.js';

function makeReq(mode: ElicitationRequest['mode'], schema?: ElicitationRequest['schema']): ElicitationRequest {
  return {
    id: 'e1', mcpServerName: 'git', mode, schema,
    description: 'Authorize GitHub', url: 'https://example.com/auth',
    resolve: () => { /* noop */ },
  };
}

function makeState() {
  return newSessionRenderState({
    sessionId: 's1', shortAlias: 'abcd',
    workspaceId: 'w1', workspaceName: 'ws',
    targets: [{ channelType: 'discord', chatId: '10', role: 'primary' }],
  });
}

describe('elicitation-form', () => {
  it('confirm mode → two-button inline keyboard', () => {
    const m = buildElicitationMarkup(makeReq('confirm'), true);
    expect(m.type).toBe('inline_keyboard');
    const flat = (m.buttons ?? []).flat().map((b) => b.text);
    expect(flat).toContain('✅ Accept');
    expect(flat).toContain('❌ Decline');
  });

  it('url-auth mode → Open button with url', () => {
    const m = buildElicitationMarkup(makeReq('url-auth'), true);
    const open = (m.buttons ?? []).flat().find((b) => b.text.includes('Open'));
    expect(open?.url).toBe('https://example.com/auth');
  });

  it('form mode with modal capability → modal type', () => {
    const m = buildElicitationMarkup(makeReq('form', { name: { type: 'string', required: true } }), true);
    expect(m.type).toBe('modal');
    expect(m.formFields?.[0]?.name).toBe('name');
  });

  it('form mode without modal → force_reply', () => {
    const m = buildElicitationMarkup(makeReq('form', { name: { type: 'string' } }), false);
    expect(m.type).toBe('force_reply');
  });

  it('renderer sends + edits on resolve', async () => {
    const adapter = new FakeAdapter('discord');
    const state = makeState();
    const target = state.targets[0]!;
    const r = new ElicitationFormRenderer({ adapter, capabilities: CAPABILITIES.discord, session: state, target });
    const req = makeReq('confirm');
    await r.onPending(req);
    expect(adapter.byKind('send')).toHaveLength(1);
    await r.onResolved(req.id, 'accept');
    expect(adapter.byKind('edit')).toHaveLength(1);
    expect(adapter.byKind('edit')[0]!.args.text).toBe('✅ Submitted');
  });

  it('feishu form mode invokes sendFormCard (not buildInlineCard)', async () => {
    const adapter = new FakeAdapter('feishu');
    // Attach a fake sendFormCard hook; mirrors FeishuAdapter shape.
    const formCardCalls: Array<{ chatId: string; spec: unknown }> = [];
    (adapter as unknown as { sendFormCard: (chatId: string, spec: unknown) => Promise<string> })
      .sendFormCard = async (chatId, spec) => {
        formCardCalls.push({ chatId, spec });
        return 'form-msg-1';
      };
    const state = newSessionRenderState({
      sessionId: 's1', shortAlias: 'abcd',
      workspaceId: 'w1', workspaceName: 'ws',
      targets: [{ channelType: 'feishu', chatId: '42', role: 'primary' }],
    });
    const target = state.targets[0]!;
    const r = new ElicitationFormRenderer({ adapter, capabilities: CAPABILITIES.feishu, session: state, target });
    await r.onPending(makeReq('form', { token: { type: 'string', required: true } }));
    expect(formCardCalls).toHaveLength(1);
    expect(formCardCalls[0]!.chatId).toBe('42');
    // The generic send() should NOT have been used for the form card.
    expect(adapter.byKind('send')).toHaveLength(0);
  });

  it('discord form mode stashes spec in pendingModals and sends Open-form button', async () => {
    const adapter = new FakeAdapter('discord');
    // Discord adapter duck-type: add pendingModals Map.
    const pendingModals = new Map<string, { title: string; fields: unknown[] }>();
    (adapter as unknown as { pendingModals: typeof pendingModals }).pendingModals = pendingModals;
    const state = newSessionRenderState({
      sessionId: 's1', shortAlias: 'abcd',
      workspaceId: 'w1', workspaceName: 'ws',
      targets: [{ channelType: 'discord', chatId: '10', role: 'primary' }],
    });
    const target = state.targets[0]!;
    const r = new ElicitationFormRenderer({ adapter, capabilities: CAPABILITIES.discord, session: state, target });
    const req = makeReq('form', { token: { type: 'string', required: true } });
    await r.onPending(req);
    // Spec stashed for T7 CallbackRouter.
    expect(pendingModals.has(req.id)).toBe(true);
    // A regular send with an "Open form" button happened.
    expect(adapter.byKind('send')).toHaveLength(1);
    const markup = adapter.byKind('send')[0]!.args.replyMarkup as {
      buttons?: Array<Array<{ text: string; callbackData?: string }>>;
    };
    const flat = (markup.buttons ?? []).flat();
    const open = flat.find((b) => b.text.includes('Open form'));
    expect(open?.callbackData).toBe(`elic:open:${req.id}`);
  });

  it('telegram form mode uses forceReply (no modal capability)', async () => {
    const adapter = new FakeAdapter('telegram');
    const state = newSessionRenderState({
      sessionId: 's1', shortAlias: 'abcd',
      workspaceId: 'w1', workspaceName: 'ws',
      targets: [{ channelType: 'telegram', chatId: '30', role: 'primary' }],
    });
    const target = state.targets[0]!;
    const r = new ElicitationFormRenderer({ adapter, capabilities: CAPABILITIES.telegram, session: state, target });
    await r.onPending(makeReq('form', { token: { type: 'string', required: true } }));
    const send = adapter.byKind('send')[0]!;
    const markup = send.args.replyMarkup as { type: string };
    expect(markup.type).toBe('force_reply');
  });
});
