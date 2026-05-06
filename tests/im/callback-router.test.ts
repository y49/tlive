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

  it('workspace:config:open replies placeholder', async () => {
    const { router, sentMsgs } = setup();
    const result = await router.route(ctx('workspace:config:open'));
    expect(result).toEqual({ kind: 'handled', action: 'workspace:config:open' });
    expect(sentMsgs[0]?.text).toMatch(/Task 22|配置/);
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
});
