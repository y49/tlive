import { describe, it, expect, vi } from 'vitest';
import { PermissionRouter } from '../permission-router';

const chats = () => [{ channel: 'telegram', chatId: 'c1' }];
const askAll = () => ({ decision: 'ask' as const });
const card = () => ({ title: 't', body: 'b' });
const base = (over = {}) => ({
  configuredChats: chats, isMuted: () => false,
  sendToChat: vi.fn().mockResolvedValue(undefined),
  hasWebClients: () => false,
  policyDecide: askAll, renderCard: card,
  graceSec: () => 0, // existing suites answer synchronously — keep them instant
  ...over,
});

describe('PermissionRouter (configured-chats, allow/deny/defer)', () => {
  it('defers after timeout (bounded pending)', async () => {
    vi.useFakeTimers();
    const r = new PermissionRouter(base());
    const p = r.requestPermission({ cwd: '/p/foo', toolName: 'Bash', input: {} });
    vi.advanceTimersByTime(581_000);
    expect((await p).decision).toBe('defer');
    vi.useRealTimers();
  });
  it('defers immediately when muted', async () => {
    const send = vi.fn();
    const r = new PermissionRouter(base({ sendToChat: send, isMuted: () => true }));
    expect((await r.requestPermission({ cwd: '/x', toolName: 'Bash', input: {} })).decision).toBe('defer');
    expect(send).not.toHaveBeenCalled();
  });
  it('defers when no chat configured', async () => {
    const r = new PermissionRouter(base({ configuredChats: () => [] }));
    expect((await r.requestPermission({ cwd: '/nowhere', toolName: 'Bash', input: {} })).decision).toBe('defer');
  });
  it('allow when answered true', async () => {
    let id = '';
    const r = new PermissionRouter(base({ sendToChat: async (_t: unknown, c: { requestId: string }) => { id = c.requestId; } }));
    const p = r.requestPermission({ cwd: '/p/foo', toolName: 'Bash', input: { cmd: 'ls' } });
    await new Promise((res) => setTimeout(res, 0));
    r.answer(id, true);
    expect((await p).decision).toBe('allow');
  });
  it('deny when answered false', async () => {
    let id = '';
    const r = new PermissionRouter(base({ sendToChat: async (_t: unknown, c: { requestId: string }) => { id = c.requestId; } }));
    const p = r.requestPermission({ cwd: '/p/foo', toolName: 'Write', input: {} });
    await new Promise((res) => setTimeout(res, 0));
    r.answer(id, false);
    expect((await p).decision).toBe('deny');
  });
});

describe('PermissionRouter pending lifecycle callbacks', () => {
  it('fires onPending when a card is sent and onResolved when answered', async () => {
    const pend: unknown[] = [];
    const done: unknown[] = [];
    let id = '';
    const r = new PermissionRouter(base({
      renderCard: () => ({ title: 'T', body: 'B' }),
      sendToChat: async (_t: unknown, c: { requestId: string }) => { id = c.requestId; },
      onPending: (p: unknown) => pend.push(p),
      onResolved: (p: unknown) => done.push(p),
    }));
    const p = r.requestPermission({ cwd: '/p/foo', toolName: 'Bash', input: {} });
    await new Promise((res) => setTimeout(res, 0));
    expect(pend).toEqual([{ cwd: '/p/foo', requestId: id, title: 'T', body: 'B', toolName: 'Bash' }]);
    r.answer(id, true);
    await p;
    expect(done).toEqual([{ cwd: '/p/foo', requestId: id, decision: 'allow' }]);
  });

  it('does not fire onPending when muted (deferred before a card)', async () => {
    const pend: unknown[] = [];
    const r = new PermissionRouter(base({ isMuted: () => true, onPending: (p: unknown) => pend.push(p) }));
    await r.requestPermission({ cwd: '/x', toolName: 'Bash', input: {} });
    expect(pend).toEqual([]);
  });
});

describe('PermissionRouter policy short-circuit', () => {
  it('auto-allows without sending a card when policy says allow', async () => {
    const send = vi.fn();
    const r = new PermissionRouter(base({ policyDecide: () => ({ decision: 'allow', reason: 'read-only' }), sendToChat: send }));
    const res = await r.requestPermission({ cwd: '/p', toolName: 'Read', input: {}, permissionMode: 'default' });
    expect(res.decision).toBe('allow');
    expect(send).not.toHaveBeenCalled();
  });
  it('renders the card via renderCard when policy says ask', async () => {
    const render = vi.fn().mockReturnValue({ title: 'T', body: 'B' });
    let sent: { title?: string; body: string } | undefined;
    const r = new PermissionRouter(base({ renderCard: render, sendToChat: async (_t: unknown, c: { title?: string; body: string }) => { sent = c; } }));
    const p = r.requestPermission({ cwd: '/p', toolName: 'Bash', input: { command: 'ls' } });
    await new Promise((res) => setTimeout(res, 0));
    expect(render).toHaveBeenCalledWith({ toolName: 'Bash', input: { command: 'ls' } });
    expect(sent?.body).toBe('B');
    r.answer([...(r as unknown as { pending: Map<string, unknown> }).pending.keys()][0], false);
    await p;
  });
});

describe('PermissionRouter web-only gate + cancel + per-request timeout', () => {
  it('defers immediately when no IM chats AND no web clients', async () => {
    const r = new PermissionRouter(base({ configuredChats: () => [] }));
    expect((await r.requestPermission({ cwd: '/w', toolName: 'Bash', input: {} })).decision).toBe('defer');
  });

  it('sends the card to web (onPending) when no IM chats but a web client is connected', async () => {
    const pend: Array<{ requestId: string }> = [];
    const r = new PermissionRouter(base({
      configuredChats: () => [],
      hasWebClients: () => true,
      onPending: (p: { requestId: string }) => { pend.push(p); r.answer(p.requestId, true); },
    }));
    const res = await r.requestPermission({ cwd: '/w', toolName: 'Bash', input: {} });
    expect(pend).toHaveLength(1);
    expect(res.decision).toBe('allow');
  });

  it('cancel({key, toolName}) resolves only the matching pending request as local', async () => {
    let rid = '';
    const resolved: Array<{ requestId: string; decision: string }> = [];
    const r = new PermissionRouter(base({
      configuredChats: () => [],
      hasWebClients: () => true,
      onPending: (p: { requestId: string }) => { rid = p.requestId; },
      onResolved: (p: { requestId: string; decision: string }) => resolved.push({ requestId: p.requestId, decision: p.decision }),
    }));
    const p = r.requestPermission({ cwd: '/w', toolName: 'Bash', input: {} });
    await new Promise((res) => setImmediate(res));
    expect(r.cancel({ key: '/other', toolName: 'Bash' })).toBe(0); // wrong key: no-op
    expect(r.cancel({ key: '/w', toolName: 'Edit' })).toBe(0);     // wrong tool: no-op
    expect(r.cancel({ key: '/w', toolName: 'Bash' })).toBe(1);
    expect((await p).decision).toBe('local');
    expect(resolved).toEqual([{ requestId: rid, decision: 'local' }]);
  });

  it('cancel({key}) without toolName sweeps all pending for the key', async () => {
    const r = new PermissionRouter(base({ configuredChats: () => [], hasWebClients: () => true }));
    const p1 = r.requestPermission({ cwd: '/w', toolName: 'Bash', input: {} });
    const p2 = r.requestPermission({ cwd: '/w', toolName: 'Edit', input: {} });
    await new Promise((res) => setImmediate(res));
    expect(r.cancel({ key: '/w' })).toBe(2);
    expect((await p1).decision).toBe('local');
    expect((await p2).decision).toBe('local');
  });

  it('cancel does not cross sessions or sub-agents sharing key+tool', async () => {
    // 两个子 agent(同 key 同 tool 不同 agentId)各有一张 pending 卡:
    // 本地答掉 agent A 的对话框,不得误伤 agent B 的卡。
    const r = new PermissionRouter(base({ configuredChats: () => [], hasWebClients: () => true }));
    const pA = r.requestPermission({ cwd: '/w', toolName: 'Bash', input: {}, sessionId: 's1', agentId: 'agentA' });
    const pB = r.requestPermission({ cwd: '/w', toolName: 'Bash', input: {}, sessionId: 's1', agentId: 'agentB' });
    await new Promise((res) => setImmediate(res));
    expect(r.cancel({ key: '/w', toolName: 'Bash', sessionId: 's1', matchAgent: 'agentA' })).toBe(1);
    expect((await pA).decision).toBe('local');
    // agent B 的仍 pending —— 用无过滤 cancel 清场收尾
    expect(r.cancel({ key: '/w' })).toBe(1);
    expect((await pB).decision).toBe('local');
  });

  it('matchAgent tri-state: null = main-session only, undefined = any, string = that agent', async () => {
    const r = new PermissionRouter(base({ configuredChats: () => [], hasWebClients: () => true }));
    const pMain = r.requestPermission({ cwd: '/w', toolName: 'Bash', input: {} }); // 主会话卡
    const pSub = r.requestPermission({ cwd: '/w', toolName: 'Bash', input: {}, agentId: 'agentA' }); // 子 agent 卡
    await new Promise((res) => setImmediate(res));
    // 子 agent 的本地回答不得释放主会话卡;主会话回答不得释放子 agent 卡
    expect(r.cancel({ key: '/w', toolName: 'Bash', matchAgent: 'agentB' })).toBe(0);
    expect(r.cancel({ key: '/w', toolName: 'Bash', matchAgent: null })).toBe(1); // 只放主卡
    expect((await pMain).decision).toBe('local');
    // 清场(matchAgent 缺省)扫掉剩下的子 agent 卡
    expect(r.cancel({ key: '/w' })).toBe(1);
    expect((await pSub).decision).toBe('local');
  });

  it('different sessionId on the same cwd does not cancel', async () => {
    const r = new PermissionRouter(base({ configuredChats: () => [], hasWebClients: () => true }));
    const p = r.requestPermission({ cwd: '/w', toolName: 'Bash', input: {}, sessionId: 's1' });
    await new Promise((res) => setImmediate(res));
    expect(r.cancel({ key: '/w', toolName: 'Bash', sessionId: 's2' })).toBe(0);
    r.cancel({ key: '/w' });
    await p;
  });

  it('honors per-request timeoutSec', async () => {
    vi.useFakeTimers();
    try {
      const r = new PermissionRouter(base({ configuredChats: () => [], hasWebClients: () => true }));
      const p = r.requestPermission({ cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 5 });
      let settled = false;
      void p.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(settled).toBe(false); // still pending at 4s
      await vi.advanceTimersByTimeAsync(1_100);
      expect((await p).decision).toBe('defer');
    } finally { vi.useRealTimers(); }
  });
});

describe('approval grace gating', () => {
  const mkDeps = (sent: string[], graceMs: number) => ({
    configuredChats: () => [{ channel: 'telegram', chatId: 'c1' }],
    sendToChat: async (_t: unknown, card: { requestId: string }) => { sent.push(card.requestId); },
    isMuted: () => false,
    hasWebClients: () => false,
    policyDecide: () => ({ decision: 'ask' as const }),
    renderCard: () => ({ title: 'T', body: 'B' }),
    graceSec: () => graceMs / 1000,
  });

  it('never sends the card when the local terminal answers within grace', async () => {
    const sent: string[] = [];
    const r = new PermissionRouter(mkDeps(sent, 200));
    const p = r.requestPermission({ cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60 });
    await new Promise((res) => setTimeout(res, 50));
    expect(r.cancel({ key: '/w' })).toBe(1);
    expect(await p).toEqual({ decision: 'local' });
    await new Promise((res) => setTimeout(res, 300));
    expect(sent).toEqual([]); // 卡永不诞生
  });

  it('never sends the card when answered remotely within grace', async () => {
    const sent: string[] = [];
    let pendingId = '';
    const deps = { ...mkDeps(sent, 200), onPending: (p: { requestId: string }) => { pendingId = p.requestId; } };
    const r = new PermissionRouter(deps);
    const p = r.requestPermission({ cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60 });
    await new Promise((res) => setTimeout(res, 50));
    r.answer(pendingId, true);
    expect(await p).toEqual({ decision: 'allow' });
    await new Promise((res) => setTimeout(res, 300));
    expect(sent).toEqual([]);
  });

  it('sends the card once grace elapses with nobody answering', async () => {
    const sent: string[] = [];
    const r = new PermissionRouter(mkDeps(sent, 100));
    const p = r.requestPermission({ cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60 });
    await new Promise((res) => setTimeout(res, 250));
    expect(sent.length).toBe(1);
    r.cancel({ key: '/w' });
    await p;
  });

  it('broadcasts onPending immediately — the dashboard must not wait for grace', async () => {
    const sent: string[] = [];
    let pendingAt = 0;
    const t0 = Date.now();
    const deps = { ...mkDeps(sent, 500), onPending: () => { pendingAt = Date.now() - t0; } };
    const r = new PermissionRouter(deps);
    const p = r.requestPermission({ cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60 });
    await new Promise((res) => setTimeout(res, 50));
    expect(pendingAt).toBeLessThan(50);
    r.cancel({ key: '/w' });
    await p;
  });

  it('respects a mute that lands during grace', async () => {
    const sent: string[] = [];
    let muted = false;
    const r = new PermissionRouter({ ...mkDeps(sent, 150), isMuted: () => muted });
    const p = r.requestPermission({ cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60 });
    muted = true;
    await new Promise((res) => setTimeout(res, 250));
    expect(sent).toEqual([]);
    r.cancel({ key: '/w' });
    await p;
  });
});
