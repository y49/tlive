// tests/im/callback-router.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import { CallbackRouter, parseCallbackData } from '../../src/im/callback-router.js';
import { WorkspaceManager } from '../../src/workspace/manager.js';
import { WorkspaceCreateBroker } from '../../src/im/workspace-create-broker.js';
import type { PermissionBroker } from '../../src/permission/broker.js';
import type { AskUserQuestionBroker } from '../../src/permission/ask-broker.js';
import type { ElicitationBroker } from '../../src/permission/elicitation-broker.js';
import type { SessionManager } from '../../src/session/manager.js';
import type { LocalSession } from '../../src/session/local-session.js';
import type { PermissionRequest } from '../../src/runtime/types.js';
import type { PolicyStore, PolicyRule } from '../../src/permission/policy-store.js';
import type { PlatformAdapter, ReplyMarkup, OutboundMessage } from '../../src/platform/types.js';

function fakeBrokerCalls() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const permissionBroker = {
    resolve: (...a: unknown[]) => { calls.push({ name: 'perm.resolve', args: a }); return true; },
    pendingFor: () => [],
  } as unknown as PermissionBroker;
  const askBroker = {
    resolve: (...a: unknown[]) => { calls.push({ name: 'ask.resolve', args: a }); return true; },
    pendingFor: (sid: string) => sid === 'sess-live' ? [{ id: 'req1', options: [{ label: 'A' }, { label: 'B' }] } as Parameters<AskUserQuestionBroker['resolve']>[0] extends never ? never : { id: string; options: string[] }] : [],
  } as unknown as AskUserQuestionBroker;
  const elicitationBroker = {
    resolve: (...a: unknown[]) => { calls.push({ name: 'elic.resolve', args: a }); return true; },
    pendingFor: () => [],
  } as unknown as ElicitationBroker;
  return { calls, permissionBroker, askBroker, elicitationBroker };
}

function fakeSM(livePresent: boolean, prefixMatches = true): SessionManager {
  const live = livePresent ? {
    id: 'sess-live', kind: 'local', shortAlias: 'sessl',
    queue: { cancel: () => true },
    sendInput: async () => undefined,
  } as unknown as LocalSession : null;
  return {
    get: (id: string) => id === 'sess-live' ? live : null,
    getByPrefix: (p: string) => prefixMatches && p === 'sess' && live
      ? { resolved: live, ambiguous: [] }
      : { resolved: null, ambiguous: [] },
    listInfo: () => live ? [{ id: 'sess-live', shortAlias: 'sessl', kind: 'local',
      provider: 'claude', workspaceId: 'ws', workdir: '/tmp',
      status: { phase: 'idle' }, cost: {} as Parameters<SessionManager['listInfo']>[0] extends never ? never : {
        totalCost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      },
      createdAt: Date.now(), lastActivityAt: Date.now(),
    }] : [],
    resumeLocal: async (id: string) => id === 'can-resume' ? ({ id, shortAlias: id } as unknown as LocalSession) : null,
  } as unknown as SessionManager;
}

describe('parseCallbackData', () => {
  it('splits kind and parts', () => {
    expect(parseCallbackData('perm:allow:s1:r1')).toEqual({ kind: 'perm', parts: ['allow', 's1', 'r1'] });
  });
  it('returns null on empty', () => {
    expect(parseCallbackData('')).toBeNull();
  });
});

describe('CallbackRouter', () => {
  let sm: SessionManager;
  let router: CallbackRouter;
  let calls: Array<{ name: string; args: unknown[] }>;

  beforeEach(() => {
    sm = fakeSM(true);
    const brokers = fakeBrokerCalls();
    calls = brokers.calls;
    router = new CallbackRouter({
      sessionManager: sm,
      permissionBroker: brokers.permissionBroker,
      askBroker: brokers.askBroker,
      elicitationBroker: brokers.elicitationBroker,
    });
  });

  it('routes perm:allow → PermissionBroker.resolve allow', async () => {
    const out = await router.route({
      data: 'perm:allow:sess:req1', userId: 'u', chatId: 'c',
      channelType: 'telegram',
    });
    expect(out.kind).toBe('handled');
    expect(calls[0]?.name).toBe('perm.resolve');
    expect(calls[0]?.args[2]).toBe('allow');
  });

  it('routes perm:deny → resolve deny', async () => {
    await router.route({ data: 'perm:deny:sess:req1', userId: 'u', chatId: 'c', channelType: 'telegram' });
    expect(calls[0]?.args[2]).toBe('deny');
  });

  it('routes perm:always → resolve allow_always', async () => {
    await router.route({ data: 'perm:always:sess:req1', userId: 'u', chatId: 'c', channelType: 'telegram' });
    expect(calls[0]?.args[2]).toBe('allow_always');
  });

  it('routes ask:<reqId>:<optIdx> legacy form', async () => {
    // legacy form — scans listInfo for session owning reqId
    const brokers = fakeBrokerCalls();
    // Make askBroker.pendingFor return the request for sess-live
    (brokers.askBroker as unknown as { pendingFor: (s: string) => unknown[] }).pendingFor = (sid: string) =>
      sid === 'sess-live' ? [{ id: 'req1', options: [{ label: 'A' }, { label: 'B' }] }] : [];
    router = new CallbackRouter({
      sessionManager: sm,
      permissionBroker: brokers.permissionBroker,
      askBroker: brokers.askBroker,
      elicitationBroker: brokers.elicitationBroker,
    });
    const out = await router.route({
      data: 'ask:req1:1', userId: 'u', chatId: 'c', channelType: 'telegram',
    });
    expect(out.kind).toBe('handled');
    expect(brokers.calls.find((c) => c.name === 'ask.resolve')?.args[2]).toEqual(['B']);
  });

  it('routes elic:submit → accept', async () => {
    const out = await router.route({
      data: 'elic:submit:sess:req-e', userId: 'u', chatId: 'c', channelType: 'telegram',
    });
    expect(out.kind).toBe('handled');
    expect(calls[0]?.name).toBe('elic.resolve');
    expect((calls[0]?.args[2] as { action: string }).action).toBe('accept');
  });

  it('routes elic:cancel → decline', async () => {
    await router.route({ data: 'elic:cancel:sess:req-e', userId: 'u', chatId: 'c', channelType: 'telegram' });
    expect((calls[0]?.args[2] as { action: string }).action).toBe('decline');
  });

  it('routes takeback:<sid> → resumeLocal', async () => {
    // Kill the live session first so we exercise the resume branch.
    sm = fakeSM(false);
    const brokers = fakeBrokerCalls();
    router = new CallbackRouter({
      sessionManager: sm,
      permissionBroker: brokers.permissionBroker,
      askBroker: brokers.askBroker,
      elicitationBroker: brokers.elicitationBroker,
    });
    const out = await router.route({ data: 'takeback:can-resume', userId: 'u', chatId: 'c', channelType: 'telegram' });
    expect(out.kind).toBe('handled');
  });

  it('stale-session (not live, no meta) → invalidated', async () => {
    sm = fakeSM(false, false);
    const brokers = fakeBrokerCalls();
    router = new CallbackRouter({
      sessionManager: sm,
      permissionBroker: brokers.permissionBroker,
      askBroker: brokers.askBroker,
      elicitationBroker: brokers.elicitationBroker,
    });
    const out = await router.route({
      data: 'perm:allow:gone:r1', userId: 'u', chatId: 'c', channelType: 'telegram',
    });
    expect(out.kind).toBe('stale');
  });

  it('routes queue:cancel → session.queue.cancel', async () => {
    const out = await router.route({
      data: 'queue:cancel:sess:input1', userId: 'u', chatId: 'c', channelType: 'telegram',
    });
    expect(out.kind).toBe('handled');
    expect(out.action).toBe('queue:cancel');
  });

  it('routes suggest:<sid>:<text> → sendInput', async () => {
    const sentInputs: string[] = [];
    (sm.get as unknown as { (id: string): unknown }) = (id: string) =>
      id === 'sess-live'
        ? ({ id, kind: 'local', sendInput: async (t: string) => { sentInputs.push(t); } } as unknown)
        : null;
    (sm.getByPrefix as unknown as { (p: string): unknown }) = (p: string) =>
      p === 'sess' ? { resolved: { id: 'sess-live' }, ambiguous: [] } : { resolved: null, ambiguous: [] };
    const out = await router.route({
      data: 'suggest:sess:hello world', userId: 'u', chatId: 'c', channelType: 'telegram',
    });
    expect(out.kind).toBe('handled');
    expect(sentInputs).toEqual(['hello world']);
  });

  it('unknown kind → unknown', async () => {
    const out = await router.route({ data: 'nope:whatever', userId: 'u', chatId: 'c', channelType: 'telegram' });
    expect(out.kind).toBe('unknown');
  });
});

describe('CallbackRouter — menu:expand / menu:collapse (Task 30)', () => {
  function setup() {
    const edits: Array<{ messageId: string; chatId: string; text?: string; markup?: ReplyMarkup }> = [];
    const adapter = {
      channelType: 'telegram',
      async start() {},
      async stop() {},
      async send() { return 'm'; },
      async edit(messageId: string, chatId: string, text?: string, markup?: ReplyMarkup) {
        edits.push({ messageId, chatId, text, markup });
      },
      async delete() {},
      async pin() {},
      async setReaction() {},
      async sendAttachment() { return 'm'; },
      async downloadAttachment() { return Buffer.from(''); },
      onInbound: () => () => undefined,
    } as unknown as PlatformAdapter;
    const brokers = fakeBrokerCalls();
    const router = new CallbackRouter({
      sessionManager: fakeSM(false),
      permissionBroker: brokers.permissionBroker,
      askBroker: brokers.askBroker,
      elicitationBroker: brokers.elicitationBroker,
      adapters: { telegram: adapter },
    });
    return { router, edits };
  }

  it('menu:expand swaps keyboard to 12-button second-level + collapse row', async () => {
    const { router, edits } = setup();
    const out = await router.route({
      data: 'menu:expand', userId: 'u1', chatId: 'c1', messageId: 'm-detail',
      channelType: 'telegram',
    });
    expect(out).toEqual({ kind: 'handled', action: 'menu:expand' });
    expect(edits).toHaveLength(1);
    expect(edits[0]?.messageId).toBe('m-detail');
    expect(edits[0]?.text).toBeUndefined();
    const buttons = (edits[0]?.markup?.buttons ?? []).flat();
    // 12 second-level + 1 collapse row = 13 buttons.
    expect(buttons.length).toBe(13);
    const labels = buttons.map((b) => b.text);
    expect(labels).toContain('🔄 model');
    expect(labels).toContain('🎚 mode');
    expect(labels).toContain('🧠 think');
    expect(labels).toContain('💰 cost');
    expect(labels).toContain('✨ perm');
    expect(labels).toContain('💸 budget');
    expect(labels).toContain('📁 切ws');
    expect(labels).toContain('🔍 find');
    expect(labels).toContain('🍴 fork');
    expect(labels).toContain('📝 rename');
    expect(labels).toContain('☠ kill');
    expect(labels).toContain('📤 export');
    expect(labels).toContain('↩ 关闭菜单');
  });

  it('menu:collapse swaps back to default 4-button row', async () => {
    const { router, edits } = setup();
    const out = await router.route({
      data: 'menu:collapse', userId: 'u1', chatId: 'c1', messageId: 'm-detail',
      channelType: 'telegram',
    });
    expect(out).toEqual({ kind: 'handled', action: 'menu:collapse' });
    expect(edits).toHaveLength(1);
    const buttons = (edits[0]?.markup?.buttons ?? []).flat();
    expect(buttons).toHaveLength(4);
    expect(buttons.map((b) => b.text)).toEqual(['🆕 new', '📋 list', '⏸ 中断', '⋯']);
    expect(buttons.map((b) => b.callbackData)).toEqual([
      'session:new', 'session:list', 'turn:stop', 'menu:expand',
    ]);
  });

  it('menu without messageId returns unknown (no-op)', async () => {
    const { router, edits } = setup();
    const out = await router.route({
      data: 'menu:expand', userId: 'u1', chatId: 'c1',
      channelType: 'telegram',
    });
    expect(out.kind).toBe('unknown');
    expect((out as { reason: string }).reason).toBe('menu:no-messageId');
    expect(edits).toHaveLength(0);
  });

  it('menu without adapter returns unknown', async () => {
    const brokers = fakeBrokerCalls();
    const router = new CallbackRouter({
      sessionManager: fakeSM(false),
      permissionBroker: brokers.permissionBroker,
      askBroker: brokers.askBroker,
      elicitationBroker: brokers.elicitationBroker,
      // no adapters
    });
    const out = await router.route({
      data: 'menu:expand', userId: 'u1', chatId: 'c1', messageId: 'm-detail',
      channelType: 'telegram',
    });
    expect(out.kind).toBe('unknown');
    expect((out as { reason: string }).reason).toBe('menu:no-adapter');
  });

  it('menu:bad-verb returns unknown', async () => {
    const { router } = setup();
    const out = await router.route({
      data: 'menu:nope', userId: 'u1', chatId: 'c1', messageId: 'm-detail',
      channelType: 'telegram',
    });
    expect(out.kind).toBe('unknown');
    expect((out as { reason: string }).reason).toBe('menu:bad-verb:nope');
  });
});

describe('CallbackRouter — turn/session/runtime/cost/find handlers (Task 31)', () => {
  function setupAdvanced(opts: {
    activeSessionId?: string | null;
    sessionShape?: Partial<{
      interrupt: () => Promise<void>;
      stop: () => Promise<void>;
      setModel: (id: string) => Promise<void>;
      setPermissionMode: (m: string) => Promise<void>;
      setMaxBudget: (n: number | undefined) => void;
      forkSession: () => Promise<{ sdkSessionId: string }>;
      kind: string;
    }>;
    resumeReturns?: 'session' | 'null' | 'throw';
    policyStore?: { list: () => unknown[]; remove: (id: string) => Promise<boolean> };
  } = {}) {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const sessionId = 'sess-active-abc1234';
    const sessionShape = opts.sessionShape ?? {};
    const session = opts.activeSessionId !== null
      ? {
          id: sessionId,
          kind: sessionShape.kind ?? 'local',
          interrupt: sessionShape.interrupt ?? (async () => { calls.push({ name: 'interrupt', args: [] }); }),
          stop: sessionShape.stop ?? (async () => { calls.push({ name: 'stop', args: [] }); }),
          setModel: sessionShape.setModel ?? (async (id: string) => { calls.push({ name: 'setModel', args: [id] }); }),
          setPermissionMode: sessionShape.setPermissionMode ?? (async (m: string) => { calls.push({ name: 'setPermissionMode', args: [m] }); }),
          setMaxBudget: sessionShape.setMaxBudget ?? ((n: number | undefined) => { calls.push({ name: 'setMaxBudget', args: [n] }); }),
          forkSession: sessionShape.forkSession ?? (async () => {
            calls.push({ name: 'forkSession', args: [] });
            return { sdkSessionId: 'sess-forked-xyz7890' };
          }),
        }
      : null;

    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 'tlive', workdir: '/p/t' });
    wm.addBinding(ws.id, { channelType: 'telegram', chatId: 'c1', role: 'primary' });
    if (opts.activeSessionId !== null && opts.activeSessionId !== undefined) {
      wm.bindActiveSession(ws.id, opts.activeSessionId);
    } else if (opts.activeSessionId === undefined && session) {
      wm.bindActiveSession(ws.id, session.id);
    }

    const sm = {
      get: (id: string) => session && id === session.id ? session : null,
      getByPrefix: (p: string) =>
        session && session.id.startsWith(p) ? { resolved: session, ambiguous: [] } : { resolved: null, ambiguous: [] },
      listInfo: () => [],
      resumeLocal: async (id: string) => {
        if (opts.resumeReturns === 'throw') throw new Error('resume failed');
        if (opts.resumeReturns === 'null') return null;
        return { id, kind: 'local' } as unknown as LocalSession;
      },
    } as unknown as SessionManager;

    const sentMsgs: OutboundMessage[] = [];
    const adapter = {
      channelType: 'telegram',
      async start() {},
      async stop() {},
      async send(m: OutboundMessage) { sentMsgs.push(m); return 'msg-1'; },
      async edit() {},
      async delete() {},
      async pin() {},
      async setReaction() {},
      async sendAttachment() { return 'm'; },
      async downloadAttachment() { return Buffer.from(''); },
      onInbound: () => () => undefined,
    } as unknown as PlatformAdapter;

    const brokers = fakeBrokerCalls();
    const policyStoreFor = opts.policyStore
      ? () => opts.policyStore as unknown as PolicyStore
      : undefined;
    const router = new CallbackRouter({
      sessionManager: sm,
      permissionBroker: brokers.permissionBroker,
      askBroker: brokers.askBroker,
      elicitationBroker: brokers.elicitationBroker,
      adapters: { telegram: adapter },
      workspaceManager: wm,
      policyStoreFor,
    });

    return { router, wm, ws, sm, sentMsgs, calls, session };
  }

  function ctx(data: string) {
    return {
      data,
      userId: 'u1',
      chatId: 'c1',
      messageId: 'm1',
      channelType: 'telegram' as const,
    };
  }

  it('turn:stop interrupts the active session', async () => {
    const { router, calls, sentMsgs } = setupAdvanced();
    const out = await router.route(ctx('turn:stop'));
    expect(out).toEqual({ kind: 'handled', action: 'turn:stop' });
    expect(calls.find((c) => c.name === 'interrupt')).toBeDefined();
    expect(sentMsgs[0]?.text).toMatch(/已中断/);
  });

  it('turn:stop:idle replies softly without touching session', async () => {
    const { router, calls, sentMsgs } = setupAdvanced();
    const out = await router.route(ctx('turn:stop:idle'));
    expect(out).toEqual({ kind: 'handled', action: 'turn:stop:idle' });
    expect(calls).toHaveLength(0);
    expect(sentMsgs[0]?.text).toMatch(/没有进行中的对话/);
  });

  it('runtime:model:set:<id> calls setModel + persists default + replies', async () => {
    const { router, calls, ws, sentMsgs } = setupAdvanced();
    const out = await router.route(ctx('runtime:model:set:claude-opus-4-7'));
    expect(out.kind).toBe('handled');
    expect((out as { action: string }).action).toBe('runtime:model:set:claude-opus-4-7');
    expect(calls.find((c) => c.name === 'setModel')?.args[0]).toBe('claude-opus-4-7');
    expect(ws.defaults.model).toBe('claude-opus-4-7');
    expect(sentMsgs[0]?.text).toMatch(/模型已切到/);
  });

  it('runtime:mode:set:<m> calls setPermissionMode + persists', async () => {
    const { router, calls, ws } = setupAdvanced();
    const out = await router.route(ctx('runtime:mode:set:plan'));
    expect(out.kind).toBe('handled');
    expect(calls.find((c) => c.name === 'setPermissionMode')?.args[0]).toBe('plan');
    expect(ws.defaults.permissionMode).toBe('plan');
  });

  it('runtime:think:set:<l> persists ws.defaults.thinking (no session call)', async () => {
    const { router, calls, ws } = setupAdvanced();
    const out = await router.route(ctx('runtime:think:set:expanded'));
    expect(out.kind).toBe('handled');
    expect(ws.defaults.thinking).toBe('expanded');
    // No setPermissionMode/setModel call — thinking is workspace-only.
    expect(calls.find((c) => c.name === 'setPermissionMode')).toBeUndefined();
    expect(calls.find((c) => c.name === 'setModel')).toBeUndefined();
  });

  it('runtime:budget:set:25 calls setMaxBudget(25)', async () => {
    const { router, calls, sentMsgs } = setupAdvanced();
    const out = await router.route(ctx('runtime:budget:set:25'));
    expect(out.kind).toBe('handled');
    expect(calls.find((c) => c.name === 'setMaxBudget')?.args[0]).toBe(25);
    expect(sentMsgs[0]?.text).toMatch(/\$25\.00/);
  });

  it('runtime:budget:set:unlimited calls setMaxBudget(undefined)', async () => {
    const { router, calls, sentMsgs } = setupAdvanced();
    const out = await router.route(ctx('runtime:budget:set:unlimited'));
    expect(out.kind).toBe('handled');
    expect(calls.find((c) => c.name === 'setMaxBudget')?.args[0]).toBeUndefined();
    expect(sentMsgs[0]?.text).toMatch(/无上限/);
  });

  it('session:fork calls forkSession + bindActiveSession + replies', async () => {
    const { router, calls, wm, ws, sentMsgs } = setupAdvanced();
    const out = await router.route(ctx('session:fork'));
    expect(out.kind).toBe('handled');
    expect(calls.find((c) => c.name === 'forkSession')).toBeDefined();
    expect(wm.get(ws.id)?.activeSessionId).toBe('sess-forked-xyz7890');
    expect(sentMsgs[0]?.text).toMatch(/已 fork/);
  });

  it('session:kill:confirm sends confirmation card', async () => {
    const { router, sentMsgs } = setupAdvanced();
    const out = await router.route(ctx('session:kill:confirm'));
    expect(out.kind).toBe('handled');
    expect((out as { action: string }).action).toBe('session:kill:prompt');
    expect(sentMsgs[0]?.text).toMatch(/确定杀死/);
    const markup = sentMsgs[0]?.replyMarkup as ReplyMarkup;
    const datas = (markup.buttons ?? []).flat().map((b) => b.callbackData);
    expect(datas).toContain('session:kill:do');
    expect(datas).toContain('session:kill:cancel');
  });

  it('session:kill:do stops session + clears active + replies', async () => {
    const { router, calls, wm, ws, sentMsgs } = setupAdvanced();
    const out = await router.route(ctx('session:kill:do'));
    expect(out).toEqual({ kind: 'handled', action: 'session:kill:do' });
    expect(calls.find((c) => c.name === 'stop')).toBeDefined();
    expect(wm.get(ws.id)?.activeSessionId).toBeNull();
    expect(sentMsgs[0]?.text).toMatch(/已杀死/);
  });

  it('session:kill:cancel acknowledges without changes', async () => {
    const { router, calls, wm, ws } = setupAdvanced();
    const before = wm.get(ws.id)?.activeSessionId;
    const out = await router.route(ctx('session:kill:cancel'));
    expect(out.kind).toBe('handled');
    expect(calls).toHaveLength(0);
    expect(wm.get(ws.id)?.activeSessionId).toBe(before);
  });

  it('session:new prompts for confirm when active session exists', async () => {
    const { router, sentMsgs } = setupAdvanced();
    const out = await router.route(ctx('session:new'));
    expect(out.kind).toBe('handled');
    expect((out as { action: string }).action).toBe('session:new:prompt');
    const markup = sentMsgs[0]?.replyMarkup as ReplyMarkup;
    const datas = (markup.buttons ?? []).flat().map((b) => b.callbackData);
    expect(datas).toContain('session:new:confirm');
    expect(datas).toContain('session:new:cancel');
  });

  it('session:new:confirm stops + clears active', async () => {
    const { router, calls, wm, ws } = setupAdvanced();
    const out = await router.route(ctx('session:new:confirm'));
    expect(out.kind).toBe('handled');
    expect(calls.find((c) => c.name === 'stop')).toBeDefined();
    expect(wm.get(ws.id)?.activeSessionId).toBeNull();
  });

  it('session:resume:<sid> resumes + binds + replies', async () => {
    const { router, wm, ws, sentMsgs } = setupAdvanced({ activeSessionId: null });
    const out = await router.route(ctx('session:resume:sess-resumed-aaa9999'));
    expect(out.kind).toBe('handled');
    expect((out as { action: string }).action).toMatch(/^session:resume:/);
    expect(wm.get(ws.id)?.activeSessionId).toBe('sess-resumed-aaa9999');
    expect(sentMsgs[0]?.text).toMatch(/已恢复会话/);
  });

  it('runtime:model:open replies with hint', async () => {
    const { router, sentMsgs } = setupAdvanced();
    const out = await router.route(ctx('runtime:model:open'));
    expect(out).toEqual({ kind: 'handled', action: 'runtime:model:open' });
    expect(sentMsgs[0]?.text).toMatch(/请发 \/model/);
  });

  it('cost:open replies with hint', async () => {
    const { router, sentMsgs } = setupAdvanced();
    const out = await router.route(ctx('cost:open'));
    expect(out).toEqual({ kind: 'handled', action: 'cost:open' });
    expect(sentMsgs[0]?.text).toMatch(/\/cost/);
  });

  it('find:prompt replies with hint', async () => {
    const { router, sentMsgs } = setupAdvanced();
    const out = await router.route(ctx('find:prompt'));
    expect(out).toEqual({ kind: 'handled', action: 'find:prompt' });
    expect(sentMsgs[0]?.text).toMatch(/\/find/);
  });

  it('workspace:open replies with hint', async () => {
    const { router, sentMsgs } = setupAdvanced();
    const out = await router.route(ctx('workspace:open'));
    expect(out).toEqual({ kind: 'handled', action: 'workspace:open:hint' });
    expect(sentMsgs[0]?.text).toMatch(/\/workspace/);
  });

  it('runtime:perm:clear:do iterates list + removes rules', async () => {
    const removed: string[] = [];
    const policyStore = {
      list: () => [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
      remove: async (id: string) => { removed.push(id); return true; },
    };
    const { router, sentMsgs } = setupAdvanced({ policyStore });
    const out = await router.route(ctx('runtime:perm:clear:do'));
    expect(out.kind).toBe('handled');
    expect((out as { action: string }).action).toBe('runtime:perm:clear:do:3');
    expect(removed).toEqual(['r1', 'r2', 'r3']);
    expect(sentMsgs[0]?.text).toMatch(/已清空 3 条规则/);
  });

  it('runtime:perm:clear:confirm sends confirmation card', async () => {
    const { router, sentMsgs } = setupAdvanced();
    const out = await router.route(ctx('runtime:perm:clear:confirm'));
    expect(out).toEqual({ kind: 'handled', action: 'runtime:perm:clear:prompt' });
    const markup = sentMsgs[0]?.replyMarkup as ReplyMarkup;
    const datas = (markup.buttons ?? []).flat().map((b) => b.callbackData);
    expect(datas).toContain('runtime:perm:clear:do');
    expect(datas).toContain('runtime:perm:clear:cancel');
  });

  it('runtime:perm:add:allow / :deny → hint replies', async () => {
    const { router, sentMsgs } = setupAdvanced();
    await router.route(ctx('runtime:perm:add:allow'));
    expect(sentMsgs[0]?.text).toMatch(/\/perm allow/);
    sentMsgs.length = 0;
    await router.route(ctx('runtime:perm:add:deny'));
    expect(sentMsgs[0]?.text).toMatch(/\/perm deny/);
  });
});

describe('CallbackRouter perm:learn policy persistence', () => {
  it('persists PolicyRule with exec command pattern on perm:learn', async () => {
    const policyAdd: Array<Parameters<PolicyStore['add']>> = [];
    const store: Pick<PolicyStore, 'add'> = {
      async add(pattern, decision, scope, createdBy) {
        policyAdd.push([pattern, decision, scope, createdBy]);
        return { id: 'pol-1', pattern, decision, scope, createdBy, createdAt: '' } as PolicyRule;
      },
    };
    const execReq: PermissionRequest = {
      id: 'req-exec-1',
      category: 'exec',
      toolName: 'Bash',
      toolInput: { command: 'npm install lodash' },
      resolve: () => undefined,
    };
    const brokers = fakeBrokerCalls();
    (brokers.permissionBroker as unknown as { pendingFor: (s: string) => unknown[] }).pendingFor =
      (sid: string) => sid === 'sess-live' ? [execReq] : [];
    const sm = fakeSM(true);
    // fakeSM.get returns a live session for 'sess-live' — add workspaceId for
    // persistLearnedPolicy to find.
    (sm.get as unknown as (id: string) => unknown) = (id: string) =>
      id === 'sess-live'
        ? ({ id, kind: 'local', workspaceId: 'ws-42' } as unknown)
        : null;

    const router = new CallbackRouter({
      sessionManager: sm,
      permissionBroker: brokers.permissionBroker,
      askBroker: brokers.askBroker,
      elicitationBroker: brokers.elicitationBroker,
      policyStoreFor: () => store as PolicyStore,
    });

    const out = await router.route({
      data: 'perm:learn:sess:req-exec-1', userId: 'u-admin', chatId: 'c',
      channelType: 'telegram',
    });

    expect(out.kind).toBe('handled');
    expect((out as { action: string }).action).toBe('perm:learn:learn');
    // broker.resolve called with allow_always
    const resolveCall = brokers.calls.find((c) => c.name === 'perm.resolve');
    expect(resolveCall?.args[2]).toBe('allow_always');
    // policyStore.add called with exec pattern
    expect(policyAdd).toHaveLength(1);
    const [pattern, decision, scope, createdBy] = policyAdd[0]!;
    expect(pattern).toEqual({ toolName: 'Bash', inputMatch: { command: 'npm(*)' } });
    expect(decision).toBe('allow');
    expect(scope).toBe('workspace');
    expect(createdBy).toBe('u-admin');
  });

  it('persists toolName-only pattern for non-exec categories', async () => {
    const policyAdd: Array<Parameters<PolicyStore['add']>> = [];
    const store: Pick<PolicyStore, 'add'> = {
      async add(pattern, decision, scope, createdBy) {
        policyAdd.push([pattern, decision, scope, createdBy]);
        return { id: 'pol-2', pattern, decision, scope, createdBy, createdAt: '' } as PolicyRule;
      },
    };
    const editReq: PermissionRequest = {
      id: 'req-edit-1',
      category: 'file-edit',
      toolName: 'Edit',
      toolInput: { file_path: '/tmp/a', old_string: 'x', new_string: 'y' },
      resolve: () => undefined,
    };
    const brokers = fakeBrokerCalls();
    (brokers.permissionBroker as unknown as { pendingFor: (s: string) => unknown[] }).pendingFor =
      (sid: string) => sid === 'sess-live' ? [editReq] : [];
    const sm = fakeSM(true);
    (sm.get as unknown as (id: string) => unknown) = (id: string) =>
      id === 'sess-live'
        ? ({ id, kind: 'local', workspaceId: 'ws-7' } as unknown)
        : null;

    const router = new CallbackRouter({
      sessionManager: sm,
      permissionBroker: brokers.permissionBroker,
      askBroker: brokers.askBroker,
      elicitationBroker: brokers.elicitationBroker,
      policyStoreFor: () => store as PolicyStore,
    });

    await router.route({
      data: 'perm:learn:sess:req-edit-1', userId: 'u', chatId: 'c',
      channelType: 'telegram',
    });

    expect(policyAdd).toHaveLength(1);
    expect(policyAdd[0]![0]).toEqual({ toolName: 'Edit' });
  });

  it('still resolves when policyStoreFor is not wired (T9 fallback)', async () => {
    const brokers = fakeBrokerCalls();
    const sm = fakeSM(true);
    const router = new CallbackRouter({
      sessionManager: sm,
      permissionBroker: brokers.permissionBroker,
      askBroker: brokers.askBroker,
      elicitationBroker: brokers.elicitationBroker,
      // no policyStoreFor
    });
    const out = await router.route({
      data: 'perm:learn:sess:r1', userId: 'u', chatId: 'c', channelType: 'telegram',
    });
    expect(out.kind).toBe('handled');
    expect(brokers.calls.find((c) => c.name === 'perm.resolve')?.args[2]).toBe('allow_always');
  });
});

describe('CallbackRouter stale-card edits', () => {
  function fakeAdapter(): { adapter: PlatformAdapter; edits: Array<{ messageId: string; chatId: string; text?: string }> } {
    const edits: Array<{ messageId: string; chatId: string; text?: string }> = [];
    const adapter = {
      channelType: 'telegram',
      async start() {},
      async stop() {},
      async send() { return 'm'; },
      async edit(messageId: string, chatId: string, text?: string) {
        edits.push({ messageId, chatId, text });
      },
      async delete() {},
      async pin() {},
      async setReaction() {},
      async sendAttachment() { return 'm'; },
      async downloadAttachment() { return Buffer.from(''); },
      onInbound: () => () => undefined,
    } as unknown as PlatformAdapter;
    return { adapter, edits };
  }

  it('edits stale card to "invalidated" when session resolves to nothing', async () => {
    const sm = fakeSM(false, false); // no live, no prefix match, no resume
    const brokers = fakeBrokerCalls();
    const { adapter, edits } = fakeAdapter();
    const adapters = new Map<'telegram' | 'feishu', PlatformAdapter>([['telegram', adapter]]);
    const router = new CallbackRouter({
      sessionManager: sm,
      permissionBroker: brokers.permissionBroker,
      askBroker: brokers.askBroker,
      elicitationBroker: brokers.elicitationBroker,
    });
    const out = await router.route({
      data: 'perm:allow:gone:r1', userId: 'u', chatId: 'c-99', messageId: 'msg-42',
      channelType: 'telegram', adapters,
    });
    expect(out.kind).toBe('stale');
    expect((out as { action: string }).action).toBe('invalidated');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.messageId).toBe('msg-42');
    expect(edits[0]?.chatId).toBe('c-99');
    expect(edits[0]?.text).toMatch(/invalidated/i);
  });

  it('edits stale card to "already resolved" when broker.resolve returns false', async () => {
    const sm = fakeSM(true);
    const brokers = fakeBrokerCalls();
    (brokers.permissionBroker as unknown as { resolve: (...a: unknown[]) => boolean }).resolve =
      (...a: unknown[]) => { brokers.calls.push({ name: 'perm.resolve', args: a }); return false; };
    const { adapter, edits } = fakeAdapter();
    const adapters = new Map<'telegram' | 'feishu', PlatformAdapter>([['telegram', adapter]]);
    const router = new CallbackRouter({
      sessionManager: sm,
      permissionBroker: brokers.permissionBroker,
      askBroker: brokers.askBroker,
      elicitationBroker: brokers.elicitationBroker,
    });
    const out = await router.route({
      data: 'perm:allow:sess:r1', userId: 'u', chatId: 'c', messageId: 'msg-7',
      channelType: 'telegram', adapters,
    });
    expect(out.kind).toBe('stale');
    expect((out as { action: string }).action).toBe('already_resolved');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.text).toMatch(/already resolved/i);
  });

  it('no-ops cleanly when messageId/adapters absent', async () => {
    const sm = fakeSM(false, false);
    const brokers = fakeBrokerCalls();
    const router = new CallbackRouter({
      sessionManager: sm,
      permissionBroker: brokers.permissionBroker,
      askBroker: brokers.askBroker,
      elicitationBroker: brokers.elicitationBroker,
    });
    const out = await router.route({
      data: 'perm:allow:gone:r1', userId: 'u', chatId: 'c', channelType: 'telegram',
    });
    expect(out.kind).toBe('stale');
  });
});

describe('CallbackRouter — workspace:*', () => {
  function setup() {
    const wm = new WorkspaceManager();
    const wcb = new WorkspaceCreateBroker();
    const sm = {
      get: () => null,
      getByPrefix: () => ({ resolved: null, ambiguous: [] }),
      listInfo: () => [],
      resumeLocal: async () => null,
    } as unknown as SessionManager;
    const sentMsgs: OutboundMessage[] = [];
    const adapter = {
      channelType: 'telegram',
      async start() {},
      async stop() {},
      async send(m: OutboundMessage) { sentMsgs.push(m); return 'msg-1'; },
      async edit() {},
      async delete() {},
      async pin() {},
      async setReaction() {},
      async sendAttachment() { return 'm'; },
      async downloadAttachment() { return Buffer.from(''); },
      onInbound: () => () => undefined,
    } as unknown as PlatformAdapter;
    const brokers = fakeBrokerCalls();
    const router = new CallbackRouter({
      sessionManager: sm,
      permissionBroker: brokers.permissionBroker,
      askBroker: brokers.askBroker,
      elicitationBroker: brokers.elicitationBroker,
      adapters: { telegram: adapter },
      workspaceManager: wm,
      workspaceCreateBroker: wcb,
    });
    return { router, wm, wcb, sm, sentMsgs };
  }

  function ctx(data: string) {
    return {
      data,
      userId: 'u1',
      chatId: 'c1',
      messageId: 'm1',
      channelType: 'telegram' as const,
    };
  }

  it('workspace:bind binds chat to the target workspace', async () => {
    const { router, wm, sentMsgs } = setup();
    const ws = wm.create({ name: 'tlive', workdir: '/p/t' });
    const result = await router.route(ctx(`workspace:bind:${ws.id}`));
    expect(result).toEqual({ kind: 'handled', action: 'workspace:bind:tlive' });
    expect(wm.findByChat('telegram', 'c1')?.id).toBe(ws.id);
    expect(sentMsgs[0]?.text).toMatch(/已绑定/);
  });

  it('workspace:bind replaces existing binding for the chat', async () => {
    const { router, wm } = setup();
    const w1 = wm.create({ name: 'a', workdir: '/p/a' });
    const w2 = wm.create({ name: 'b', workdir: '/p/b' });
    wm.addBinding(w1.id, { channelType: 'telegram', chatId: 'c1', role: 'primary' });
    await router.route(ctx(`workspace:bind:${w2.id}`));
    expect(wm.findByChat('telegram', 'c1')?.id).toBe(w2.id);
    // w1 binding removed
    expect(wm.listBindings(w1.id).find((b) => b.chatId === 'c1')).toBeUndefined();
  });

  it('workspace:bind with unknown id replies error and returns unknown', async () => {
    const { router, wm, sentMsgs } = setup();
    const result = await router.route(ctx('workspace:bind:does-not-exist'));
    expect(result.kind).toBe('unknown');
    expect((result as { reason: string }).reason).toBe('workspace:bind:not-found');
    expect(wm.findByChat('telegram', 'c1')).toBeUndefined();
    expect(sentMsgs[0]?.text).toMatch(/不存在/);
  });

  it('workspace:create:start opens broker pending state with cancel button', async () => {
    const { router, wcb, sentMsgs } = setup();
    await router.route(ctx('workspace:create:start'));
    const pending = wcb.pendingFor('telegram', 'c1');
    expect(pending).toBeDefined();
    expect(pending?.userId).toBe('u1');
    expect(sentMsgs[0]?.text).toMatch(/请发送项目根目录/);
    const markup = sentMsgs[0]?.replyMarkup as ReplyMarkup;
    expect(markup.type).toBe('inline_keyboard');
    expect(markup.buttons?.[0]?.[0]?.callbackData).toBe('workspace:create:cancel');
  });

  it('workspace:create:cancel clears broker pending', async () => {
    const { router, wcb } = setup();
    wcb.start({ channelType: 'telegram', chatId: 'c1', userId: 'u1', triggerMessageId: 'm0' });
    await router.route(ctx('workspace:create:cancel'));
    expect(wcb.pendingFor('telegram', 'c1')).toBeUndefined();
  });

  it('workspace:exit:confirm sends confirmation card with [✅] and [❌] buttons', async () => {
    const { router, wm, sentMsgs } = setup();
    const ws = wm.create({ name: 'tlive', workdir: '/p/t' });
    wm.addBinding(ws.id, { channelType: 'telegram', chatId: 'c1', role: 'primary' });
    await router.route(ctx('workspace:exit:confirm'));
    expect(sentMsgs[0]?.text).toMatch(/确定退出/);
    const markup = sentMsgs[0]?.replyMarkup as ReplyMarkup;
    const labels = (markup.buttons ?? []).flat().map((b) => b.text);
    expect(labels).toContain('✅ 确定');
    expect(labels).toContain('❌ 取消');
    const datas = (markup.buttons ?? []).flat().map((b) => b.callbackData);
    expect(datas).toContain('workspace:exit:do');
    expect(datas).toContain('workspace:exit:cancel');
  });

  it('workspace:exit:do removes binding and replies', async () => {
    const { router, wm, sentMsgs } = setup();
    const ws = wm.create({ name: 'tlive', workdir: '/p/t' });
    wm.addBinding(ws.id, { channelType: 'telegram', chatId: 'c1', role: 'primary' });
    await router.route(ctx('workspace:exit:do'));
    expect(wm.findByChat('telegram', 'c1')).toBeUndefined();
    expect(sentMsgs[0]?.text).toMatch(/已退出/);
  });

  it('workspace:exit:cancel acknowledges without changing bindings', async () => {
    const { router, wm } = setup();
    const ws = wm.create({ name: 'tlive', workdir: '/p/t' });
    wm.addBinding(ws.id, { channelType: 'telegram', chatId: 'c1', role: 'primary' });
    await router.route(ctx('workspace:exit:cancel'));
    expect(wm.findByChat('telegram', 'c1')?.id).toBe(ws.id);
  });

  it('workspace:config:open shows workspace defaults + edit buttons (admin)', async () => {
    const { router, wm, sentMsgs } = setup();
    const ws = wm.create({
      name: 'tlive',
      workdir: '/p/t',
      defaults: { provider: 'claude', model: 'claude-sonnet-4-6', permissionMode: 'default', thinking: 'collapsed' },
    });
    wm.setRole(ws.id, 'u1', 'admin');
    wm.addBinding(ws.id, { channelType: 'telegram', chatId: 'c1', role: 'primary' });

    const result = await router.route(ctx('workspace:config:open'));
    expect(result).toEqual({ kind: 'handled', action: 'workspace:config:open' });
    expect(sentMsgs[0]?.text).toMatch(/工作区配置.*tlive/);
    expect(sentMsgs[0]?.text).toMatch(/claude-sonnet-4-6/);
    expect(sentMsgs[0]?.text).toMatch(/默认 mode.*default/);
    expect(sentMsgs[0]?.text).toMatch(/workspace 默认值/);

    const markup = sentMsgs[0]?.replyMarkup as ReplyMarkup;
    const flat = (markup.buttons ?? []).flat();
    const labels = flat.map((b) => b.text);
    expect(labels).toContain('改 model');
    expect(labels).toContain('改 mode');
    expect(labels).toContain('改 budget');
    expect(labels).toContain('改 think');
    expect(labels).toContain('↩ 返回');
    const datas = flat.map((b) => b.callbackData);
    expect(datas).toContain('runtime:model:open');
    expect(datas).toContain('runtime:mode:open');
    expect(datas).toContain('runtime:budget:open');
    expect(datas).toContain('runtime:think:open');
    expect(datas).toContain('workspace:open');
  });

  it('workspace:config:open replies "not admin" for observer role', async () => {
    const { router, wm, sentMsgs } = setup();
    const ws = wm.create({ name: 'tlive', workdir: '/p/t' });
    // No setRole — defaults to observer (default defaultRole is 'observer')
    wm.addBinding(ws.id, { channelType: 'telegram', chatId: 'c1', role: 'primary' });

    const result = await router.route(ctx('workspace:config:open'));
    expect(result).toEqual({ kind: 'handled', action: 'workspace:config:not-admin' });
    expect(sentMsgs[0]?.text).toMatch(/只有管理员/);
  });

  it('workspace:config:open replies "not bound" when chat unbound', async () => {
    const { router, sentMsgs } = setup();
    const result = await router.route(ctx('workspace:config:open'));
    expect(result).toEqual({ kind: 'handled', action: 'workspace:config:not-bound' });
    expect(sentMsgs[0]?.text).toMatch(/未绑定工作区/);
  });

  it('workspace:config with bad subverb returns unknown (admin)', async () => {
    const { router, wm } = setup();
    const ws = wm.create({ name: 'tlive', workdir: '/p/t' });
    wm.setRole(ws.id, 'u1', 'admin');
    wm.addBinding(ws.id, { channelType: 'telegram', chatId: 'c1', role: 'primary' });
    const result = await router.route(ctx('workspace:config:bogus'));
    expect(result.kind).toBe('unknown');
    expect((result as { reason: string }).reason).toBe('workspace:config:bad-verb:bogus');
  });

  it('workspace:switch swaps binding (no live session)', async () => {
    const { router, wm, sentMsgs } = setup();
    const w1 = wm.create({ name: 'a', workdir: '/p/a' });
    const w2 = wm.create({ name: 'b', workdir: '/p/b' });
    wm.addBinding(w1.id, { channelType: 'telegram', chatId: 'c1', role: 'primary' });
    const result = await router.route(ctx(`workspace:switch:${w2.id}`));
    expect(result.kind).toBe('handled');
    expect((result as { action: string }).action).toBe('workspace:switch:b');
    expect(wm.findByChat('telegram', 'c1')?.id).toBe(w2.id);
    expect(sentMsgs[0]?.text).toMatch(/已切到工作区/);
    expect(sentMsgs[0]?.text).toMatch(/暂无活跃会话/);
  });

  it('workspace:switch with unknown target replies error', async () => {
    const { router, wm } = setup();
    const w1 = wm.create({ name: 'a', workdir: '/p/a' });
    wm.addBinding(w1.id, { channelType: 'telegram', chatId: 'c1', role: 'primary' });
    const result = await router.route(ctx('workspace:switch:does-not-exist'));
    expect(result.kind).toBe('unknown');
    // Original binding intact
    expect(wm.findByChat('telegram', 'c1')?.id).toBe(w1.id);
  });

  it('returns unknown on bad workspace verb', async () => {
    const { router } = setup();
    const result = await router.route(ctx('workspace:nosuch:foo'));
    expect(result.kind).toBe('unknown');
    expect((result as { reason: string }).reason).toBe('workspace:bad-verb:nosuch');
  });

  it('returns unknown when workspaceManager dep is absent', async () => {
    const brokers = fakeBrokerCalls();
    const router = new CallbackRouter({
      sessionManager: fakeSM(false),
      permissionBroker: brokers.permissionBroker,
      askBroker: brokers.askBroker,
      elicitationBroker: brokers.elicitationBroker,
    });
    const result = await router.route({
      data: 'workspace:bind:abc', userId: 'u', chatId: 'c', channelType: 'telegram',
    });
    expect(result.kind).toBe('unknown');
    expect((result as { reason: string }).reason).toBe('workspace:no-manager');
  });

  it('workspace:switch on current workspace short-circuits with "already-on" reply', async () => {
    const { router, wm, sentMsgs } = setup();
    const ws = wm.create({ name: 'tlive', workdir: '/p/t' });
    wm.addBinding(ws.id, { channelType: 'telegram', chatId: 'c1', role: 'primary' });
    const result = await router.route(ctx(`workspace:switch:${ws.id}`));
    expect(result.kind).toBe('handled');
    expect((result as { action: string }).action).toMatch(/noop/);
    expect(sentMsgs[0]?.text).toMatch(/已经在工作区/);
    // Binding unchanged
    expect(wm.findByChat('telegram', 'c1')?.id).toBe(ws.id);
  });

  it('workspace:switch resume failure is logged and replied with warning', async () => {
    const logs: Array<{ msg: string; data: unknown }> = [];
    const fakeLogger = {
      level: 'info' as const,
      info: () => undefined,
      warn: (msg: string, data?: unknown) => { logs.push({ msg, data }); },
      error: () => undefined,
      debug: () => undefined,
      child() { return fakeLogger; },
    };

    const wm = new WorkspaceManager();
    const wcb = new WorkspaceCreateBroker();
    const w1 = wm.create({ name: 'a', workdir: '/p/a' });
    const w2 = wm.create({ name: 'b', workdir: '/p/b' });
    wm.addBinding(w1.id, { channelType: 'telegram', chatId: 'c1', role: 'primary' });
    // Plant an active session id on w2 so switch attempts a resume.
    wm.bindActiveSession(w2.id, 'sess-stale');

    const sentMsgs: OutboundMessage[] = [];
    const adapter = {
      channelType: 'telegram',
      async start() {},
      async stop() {},
      async send(m: OutboundMessage) { sentMsgs.push(m); return 'msg-1'; },
      async edit() {},
      async delete() {},
      async pin() {},
      async setReaction() {},
      async sendAttachment() { return 'm'; },
      async downloadAttachment() { return Buffer.from(''); },
      onInbound: () => () => undefined,
    } as unknown as PlatformAdapter;

    const sm = {
      get: () => null,
      getByPrefix: () => ({ resolved: null, ambiguous: [] }),
      listInfo: () => [],
      resumeLocal: async () => { throw new Error('boom: jsonl missing'); },
    } as unknown as SessionManager;

    const persistence = {
      hasSnapshot: async (sid: string) => sid === 'sess-stale',
    } as unknown as import('../../src/session/persistence.js').SessionPersistence;

    const brokers = fakeBrokerCalls();
    const router = new CallbackRouter({
      sessionManager: sm,
      permissionBroker: brokers.permissionBroker,
      askBroker: brokers.askBroker,
      elicitationBroker: brokers.elicitationBroker,
      adapters: { telegram: adapter },
      workspaceManager: wm,
      workspaceCreateBroker: wcb,
      persistence,
      logger: fakeLogger,
    });

    const result = await router.route({
      data: `workspace:switch:${w2.id}`,
      userId: 'u1',
      chatId: 'c1',
      messageId: 'm1',
      channelType: 'telegram',
    });

    expect(result.kind).toBe('handled');
    // Reply surfaces the warning to the user.
    expect(sentMsgs[0]?.text).toMatch(/上次会话恢复失败/);
    expect(sentMsgs[0]?.text).toMatch(/boom: jsonl missing/);
    // Logger captured the failure.
    const resumeLog = logs.find((l) => l.msg === 'workspace:switch resume failed');
    expect(resumeLog).toBeDefined();
    expect(resumeLog?.data).toMatchObject({
      sid: 'sess-stale',
      workspaceId: w2.id,
      reason: 'boom: jsonl missing',
    });
  });
});
