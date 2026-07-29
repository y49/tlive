import { describe, it, expect, vi } from 'vitest';
import { PermissionRouter } from '../permission-router';

const chats = () => [{ channel: 'telegram', chatId: 'c1' }];
const askAll = () => ({ decision: 'ask' as const });
const card = () => ({ title: 't', body: 'b' });
const base = (over = {}) => ({
  configuredChats: chats, isMuted: () => false,
  sendToChat: vi.fn().mockResolvedValue(undefined),
  hasWebClients: () => false,
  hasLocalAnswerPath: () => false,
  policyDecide: askAll, renderCard: card,
  graceSec: () => 0, // existing suites answer synchronously — keep them instant
  ...over,
});

describe('PermissionRouter (configured-chats, allow/deny/defer)', () => {
  it('defers after timeout (bounded pending)', async () => {
    vi.useFakeTimers();
    const r = new PermissionRouter(base());
    const p = r.requestPermission({ key: '/p/foo', cwd: '/p/foo', toolName: 'Bash', input: {} });
    vi.advanceTimersByTime(581_000);
    expect((await p).decision).toBe('defer');
    vi.useRealTimers();
  });
  it('defers immediately when muted', async () => {
    const send = vi.fn();
    const r = new PermissionRouter(base({ sendToChat: send, isMuted: () => true }));
    expect((await r.requestPermission({ key: '/x', cwd: '/x', toolName: 'Bash', input: {} })).decision).toBe('defer');
    expect(send).not.toHaveBeenCalled();
  });
  it('defers when no chat configured', async () => {
    const r = new PermissionRouter(base({ configuredChats: () => [] }));
    expect((await r.requestPermission({ key: '/nowhere', cwd: '/nowhere', toolName: 'Bash', input: {} })).decision).toBe('defer');
  });
  it('allow when answered true', async () => {
    let id = '';
    const r = new PermissionRouter(base({ sendToChat: async (_t: unknown, c: { requestId: string }) => { id = c.requestId; } }));
    const p = r.requestPermission({ key: '/p/foo', cwd: '/p/foo', toolName: 'Bash', input: { cmd: 'ls' } });
    await new Promise((res) => setTimeout(res, 0));
    r.answer(id, true);
    expect((await p).decision).toBe('allow');
  });
  it('deny when answered false', async () => {
    let id = '';
    const r = new PermissionRouter(base({ sendToChat: async (_t: unknown, c: { requestId: string }) => { id = c.requestId; } }));
    const p = r.requestPermission({ key: '/p/foo', cwd: '/p/foo', toolName: 'Write', input: {} });
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
    const p = r.requestPermission({ key: '/p/foo', cwd: '/p/foo', toolName: 'Bash', input: {} });
    await new Promise((res) => setTimeout(res, 0));
    expect(pend).toEqual([{ key: '/p/foo', cwd: '/p/foo', requestId: id, title: 'T', body: 'B', toolName: 'Bash' }]);
    r.answer(id, true);
    await p;
    expect(done).toEqual([{ key: '/p/foo', cwd: '/p/foo', requestId: id, decision: 'allow' }]);
  });

  it('muted with NO other answer surface still defers before a card (nothing can answer)', async () => {
    const pend: unknown[] = [];
    const r = new PermissionRouter(base({ isMuted: () => true, onPending: (p: unknown) => pend.push(p) }));
    await r.requestPermission({ key: '/x', cwd: '/x', toolName: 'Bash', input: {} });
    expect(pend).toEqual([]);
  });

  it('muted WITH a local (desktop) answer path still surfaces via onPending — mute silences the IM card only, not the whole approval (IM ⊥ desktop)', async () => {
    const pend: unknown[] = [];
    const send = vi.fn();
    const r = new PermissionRouter(base({ isMuted: () => true, sendToChat: send, hasLocalAnswerPath: () => true, onPending: (p: unknown) => pend.push(p) }));
    const p = r.requestPermission({ key: '/x', cwd: '/x', toolName: 'Bash', input: {}, timeoutSec: 0.05 });
    await Promise.resolve(); await Promise.resolve();
    expect(pend).toHaveLength(1);        // surfaced on desktop/dashboard, NOT deferred
    expect(send).not.toHaveBeenCalled(); // …but the IM card is suppressed by mute
    expect((await p).decision).toBe('defer'); // unanswered here → times out
  });

  it('carries key and cwd as two independent fields through onPending/onResolved — never collapses them (Task 5 review, Important)', async () => {
    const pend: Array<{ key: string; cwd: string }> = [];
    const done: Array<{ key: string; cwd: string }> = [];
    let id = '';
    const r = new PermissionRouter(base({
      renderCard: () => ({ title: 'T', body: 'B' }),
      sendToChat: async (_t: unknown, c: { requestId: string }) => { id = c.requestId; },
      onPending: (p: { key: string; cwd: string }) => pend.push(p),
      onResolved: (p: { key: string; cwd: string }) => done.push(p),
    }));
    // key (registry identity) and cwd (real directory) are deliberately different
    // values — a session id is never a directory path in practice.
    const p = r.requestPermission({ key: 'sess-xyz', cwd: '/real/project/dir', toolName: 'Bash', input: {} });
    await new Promise((res) => setTimeout(res, 0));
    expect(pend).toEqual([{ key: 'sess-xyz', cwd: '/real/project/dir', requestId: id, title: 'T', body: 'B', toolName: 'Bash' }]);
    r.answer(id, true);
    await p;
    expect(done).toEqual([{ key: 'sess-xyz', cwd: '/real/project/dir', requestId: id, decision: 'allow' }]);
  });
});

describe('PermissionRouter policy short-circuit', () => {
  it('auto-allows without sending a card when policy says allow', async () => {
    const send = vi.fn();
    const r = new PermissionRouter(base({ policyDecide: () => ({ decision: 'allow', reason: 'read-only' }), sendToChat: send }));
    const res = await r.requestPermission({ key: '/p', cwd: '/p', toolName: 'Read', input: {}, permissionMode: 'default' });
    expect(res.decision).toBe('allow');
    expect(send).not.toHaveBeenCalled();
  });
  it('renders the card via renderCard when policy says ask', async () => {
    const render = vi.fn().mockReturnValue({ title: 'T', body: 'B' });
    let sent: { title?: string; body: string } | undefined;
    const r = new PermissionRouter(base({ renderCard: render, sendToChat: async (_t: unknown, c: { title?: string; body: string }) => { sent = c; } }));
    const p = r.requestPermission({ key: '/p', cwd: '/p', toolName: 'Bash', input: { command: 'ls' } });
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
    expect((await r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {} })).decision).toBe('defer');
  });

  it('sends the card to web (onPending) when no IM chats but a web client is connected', async () => {
    const pend: Array<{ requestId: string }> = [];
    const r = new PermissionRouter(base({
      configuredChats: () => [],
      hasWebClients: () => true,
      onPending: (p: { requestId: string }) => { pend.push(p); r.answer(p.requestId, true); },
    }));
    const res = await r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {} });
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
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {} });
    await new Promise((res) => setImmediate(res));
    expect(r.cancel({ key: '/other', toolName: 'Bash' })).toBe(0); // wrong key: no-op
    expect(r.cancel({ key: '/w', toolName: 'Edit' })).toBe(0);     // wrong tool: no-op
    expect(r.cancel({ key: '/w', toolName: 'Bash' })).toBe(1);
    expect((await p).decision).toBe('local');
    expect(resolved).toEqual([{ requestId: rid, decision: 'local' }]);
  });

  it('cancel({key}) without toolName sweeps all pending for the key', async () => {
    const r = new PermissionRouter(base({ configuredChats: () => [], hasWebClients: () => true }));
    const p1 = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {} });
    const p2 = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Edit', input: {} });
    await new Promise((res) => setImmediate(res));
    expect(r.cancel({ key: '/w' })).toBe(2);
    expect((await p1).decision).toBe('local');
    expect((await p2).decision).toBe('local');
  });

  it('cancel does not cross sessions or sub-agents sharing key+tool', async () => {
    // 两个子 agent(同 key 同 tool 不同 agentId)各有一张 pending 卡:
    // 本地答掉 agent A 的对话框,不得误伤 agent B 的卡。
    const r = new PermissionRouter(base({ configuredChats: () => [], hasWebClients: () => true, holdSubagents: () => true }));
    const pA = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, sessionId: 's1', agentId: 'agentA' });
    const pB = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, sessionId: 's1', agentId: 'agentB' });
    await new Promise((res) => setImmediate(res));
    expect(r.cancel({ key: '/w', toolName: 'Bash', sessionId: 's1', matchAgent: 'agentA' })).toBe(1);
    expect((await pA).decision).toBe('local');
    // agent B 的仍 pending —— 用无过滤 cancel 清场收尾
    expect(r.cancel({ key: '/w' })).toBe(1);
    expect((await pB).decision).toBe('local');
  });

  it('matchAgent tri-state: null = main-session only, undefined = any, string = that agent', async () => {
    const r = new PermissionRouter(base({ configuredChats: () => [], hasWebClients: () => true, holdSubagents: () => true }));
    const pMain = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {} }); // 主会话卡
    const pSub = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, agentId: 'agentA' }); // 子 agent 卡
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
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, sessionId: 's1' });
    await new Promise((res) => setImmediate(res));
    expect(r.cancel({ key: '/w', toolName: 'Bash', sessionId: 's2' })).toBe(0);
    r.cancel({ key: '/w' });
    await p;
  });

  it('honors per-request timeoutSec', async () => {
    vi.useFakeTimers();
    try {
      const r = new PermissionRouter(base({ configuredChats: () => [], hasWebClients: () => true }));
      const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 5 });
      let settled = false;
      void p.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(settled).toBe(false); // still pending at 4s
      await vi.advanceTimersByTimeAsync(1_100);
      expect((await p).decision).toBe('defer');
    } finally { vi.useRealTimers(); }
  });
});

describe('PermissionRouter answer message passthrough', () => {
  it('carries the answer message through to the decision', async () => {
    let pendingId = '';
    const r = new PermissionRouter(base({ onPending: (p: { requestId: string }) => { pendingId = p.requestId; } }));
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'AskUserQuestion', input: {}, timeoutSec: 60 });
    await new Promise((res) => setTimeout(res, 10));
    r.answer(pendingId, false, 'User answered: Blue');
    expect(await p).toEqual({ decision: 'deny', message: 'User answered: Blue' });
  });

  it('omits message when none was given', async () => {
    let pendingId = '';
    const r = new PermissionRouter(base({ onPending: (p: { requestId: string }) => { pendingId = p.requestId; } }));
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60 });
    await new Promise((res) => setTimeout(res, 10));
    r.answer(pendingId, true);
    expect(await p).toEqual({ decision: 'allow' });
  });

  it('forwards the deny message to onResolved (Task 7 — deny with guidance) without losing key/cwd', async () => {
    let pendingId = '';
    const done: Array<{ key: string; cwd: string; requestId: string; decision: string; message?: string }> = [];
    const r = new PermissionRouter(base({
      onPending: (p: { requestId: string }) => { pendingId = p.requestId; },
      onResolved: (p: { key: string; cwd: string; requestId: string; decision: string; message?: string }) => done.push(p),
    }));
    const p = r.requestPermission({ key: 'sess-xyz', cwd: '/real/project/dir', toolName: 'Bash', input: {}, timeoutSec: 60 });
    await new Promise((res) => setTimeout(res, 10));
    r.answer(pendingId, false, 'Do not use rm -rf, move it to /tmp instead');
    await p;
    expect(done).toEqual([{
      key: 'sess-xyz', cwd: '/real/project/dir', requestId: pendingId,
      decision: 'deny', message: 'Do not use rm -rf, move it to /tmp instead',
    }]);
  });

  it('onResolved carries no message key at all for a plain allow (not message: undefined)', async () => {
    let pendingId = '';
    const done: Array<Record<string, unknown>> = [];
    const r = new PermissionRouter(base({
      onPending: (p: { requestId: string }) => { pendingId = p.requestId; },
      onResolved: (p: Record<string, unknown>) => done.push(p),
    }));
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60 });
    await new Promise((res) => setTimeout(res, 10));
    r.answer(pendingId, true);
    await p;
    expect('message' in done[0]).toBe(false);
  });
});

describe('PermissionRouter ask passthrough', () => {
  const ASK = { batch: { questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }] }, input: { questions: [] } };

  it('threads renderCard\'s whole ask context through to sendToChat, without affecting a plain (non-ask) card', async () => {
    let sentCard: { ask?: typeof ASK } | undefined;
    let pendingId = '';
    const r = new PermissionRouter(base({
      renderCard: () => ({ title: 'T', body: 'B', ask: ASK }),
      sendToChat: async (_t: unknown, c: { requestId: string; ask?: typeof ASK }) => { pendingId = c.requestId; sentCard = c; },
    }));
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'AskUserQuestion', input: {} });
    await new Promise((res) => setTimeout(res, 0));
    // The BATCH travels, not a flattened single question — that flattening is
    // what silently dropped questions 2..N from a multi-question answer.
    expect(sentCard?.ask).toBe(ASK);
    r.answer(pendingId, true);
    await p;
  });

  it('omits ask on the wire when renderCard does not set it (every other tool)', async () => {
    let sentCard: { ask?: unknown } | undefined;
    let pendingId = '';
    const r = new PermissionRouter(base({
      renderCard: () => ({ title: 'T', body: 'B' }),
      sendToChat: async (_t: unknown, c: { requestId: string; ask?: unknown }) => { pendingId = c.requestId; sentCard = c; },
    }));
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {} });
    await new Promise((res) => setTimeout(res, 0));
    expect(sentCard?.ask).toBeUndefined();
    r.answer(pendingId, true);
    await p;
  });
});

describe("Decision 'gone' — caller died", () => {
  it('resolves gone when the caller disconnects while pending', async () => {
    let abandon: (() => void) | undefined;
    const r = new PermissionRouter(base());
    const p = r.requestPermission({
      key: '/w', cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60,
      onAbandoned: (cb) => { abandon = cb; },
    });
    await new Promise((res) => setTimeout(res, 10));
    abandon!();
    expect(await p).toEqual({ decision: 'gone' });
  });

  it('a disconnect AFTER the answer is a no-op (normal flow, zero false positives)', async () => {
    let abandon: (() => void) | undefined;
    let pendingId = '';
    const r = new PermissionRouter({ ...base(), onPending: (p) => { pendingId = p.requestId; } });
    const p = r.requestPermission({
      key: '/w', cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60,
      onAbandoned: (cb) => { abandon = cb; },
    });
    await new Promise((res) => setTimeout(res, 10));
    r.answer(pendingId, true);
    expect(await p).toEqual({ decision: 'allow' }); // answer 先到,gone 不得覆盖
    abandon!(); // shim 拿到决策后关连接 —— 必须无害
  });

  it('a disconnect inside the grace window sends no card at all', async () => {
    const sent: string[] = [];
    let abandon: (() => void) | undefined;
    const r = new PermissionRouter({
      ...base(),
      graceSec: () => 0.15,
      sendToChat: async (_t: unknown, c: { requestId: string }) => { sent.push(c.requestId); },
    });
    const p = r.requestPermission({
      key: '/w', cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60,
      onAbandoned: (cb) => { abandon = cb; },
    });
    await new Promise((res) => setTimeout(res, 30));
    abandon!();
    expect(await p).toEqual({ decision: 'gone' });
    await new Promise((res) => setTimeout(res, 250));
    expect(sent).toEqual([]); // grace 未到就断了 → 卡根本不该诞生
  });
});

describe('answer() reports whether it hit', () => {
  it('returns true when it resolves a live pending', async () => {
    let pendingId = '';
    const r = new PermissionRouter({ ...base(), onPending: (p) => { pendingId = p.requestId; } });
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60 });
    await new Promise((res) => setTimeout(res, 10));
    expect(r.answer(pendingId, true)).toBe(true);
    await p;
  });

  it('returns false for an unknown/stale requestId (daemon restarted, card outlived it)', () => {
    const r = new PermissionRouter(base());
    expect(r.answer('no-such-request', true)).toBe(false);
  });
});

describe('approval grace gating', () => {
  const mkDeps = (sent: string[], graceMs: number) => ({
    configuredChats: () => [{ channel: 'telegram', chatId: 'c1' }],
    sendToChat: async (_t: unknown, card: { requestId: string }) => { sent.push(card.requestId); },
    isMuted: () => false,
    hasWebClients: () => false,
    hasLocalAnswerPath: () => false,
    policyDecide: () => ({ decision: 'ask' as const }),
    renderCard: () => ({ title: 'T', body: 'B' }),
    graceSec: () => graceMs / 1000,
  });

  it('never sends the card when the local terminal answers within grace', async () => {
    const sent: string[] = [];
    const r = new PermissionRouter(mkDeps(sent, 200));
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60 });
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
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60 });
    await new Promise((res) => setTimeout(res, 50));
    r.answer(pendingId, true);
    expect(await p).toEqual({ decision: 'allow' });
    await new Promise((res) => setTimeout(res, 300));
    expect(sent).toEqual([]);
  });

  it('sends the card once grace elapses with nobody answering', async () => {
    const sent: string[] = [];
    const r = new PermissionRouter(mkDeps(sent, 100));
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60 });
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
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60 });
    await new Promise((res) => setTimeout(res, 50));
    expect(pendingAt).toBeLessThan(50);
    r.cancel({ key: '/w' });
    await p;
  });

  it('respects a mute that lands during grace', async () => {
    const sent: string[] = [];
    let muted = false;
    const r = new PermissionRouter({ ...mkDeps(sent, 150), isMuted: () => muted });
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60 });
    muted = true;
    await new Promise((res) => setTimeout(res, 250));
    expect(sent).toEqual([]);
    r.cancel({ key: '/w' });
    await p;
  });
});

describe('timeoutAction (opt-in: deny on timeout instead of defer)', () => {
  it('default (unset) → a timed-out hold resolves defer (CC-native fallback, unchanged)', async () => {
    vi.useFakeTimers();
    try {
      const r = new PermissionRouter(base());
      const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 5 });
      await vi.advanceTimersByTimeAsync(5_100);
      expect((await p).decision).toBe('defer');
    } finally { vi.useRealTimers(); }
  });

  it("timeoutAction 'deny' → a timed-out hold resolves deny + a 'timed out' message (bounded block; turn ends → continue card can redirect)", async () => {
    vi.useFakeTimers();
    try {
      const r = new PermissionRouter(base({ timeoutAction: () => 'deny' }));
      const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 5 });
      await vi.advanceTimersByTimeAsync(5_100);
      const res = await p;
      expect(res.decision).toBe('deny');
      expect(res.message).toMatch(/timed out/i);
    } finally { vi.useRealTimers(); }
  });

  it("timeoutAction 'deny' does NOT affect an answered request (only the timeout path)", async () => {
    let id = '';
    const r = new PermissionRouter(base({ timeoutAction: () => 'deny', sendToChat: async (_t: unknown, c: { requestId: string }) => { id = c.requestId; } }));
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60 });
    await new Promise((res) => setTimeout(res, 10));
    r.answer(id, true);
    expect((await p).decision).toBe('allow');
  });
});

describe('sub-agent pass-through (tlive stays transparent for sub-agents by default)', () => {
  // A backgrounded/async sub-agent has NO parallel local dialog while a synchronous
  // PermissionRequest hook is held (only the main session does — first-answer-wins).
  // Holding a sub-agent would therefore introduce a block CC never has on its own,
  // with no local fallback until the window times out. So the default is pass-through
  // (defer → shim outputs {} → CC-native: local dialog if interactive, else auto-deny).
  // Remote sub-agent approval is opt-in via the top posture rung (`mode: all`,
  // see src/kernel/config/mode.ts).
  it('a sub-agent request (agentId present) passes through to defer by default — no card, no onPending, even when an answer surface exists', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const pend: unknown[] = [];
    const r = new PermissionRouter(base({ sendToChat: send, hasLocalAnswerPath: () => true, onPending: (p: unknown) => pend.push(p) }));
    const res = await r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, agentId: 'agentA', timeoutSec: 0.1 });
    expect(res.decision).toBe('defer');
    expect(send).not.toHaveBeenCalled();
    expect(pend).toEqual([]);
  });

  it('with holdSubagents opt-in, a sub-agent request holds and is remotely answerable', async () => {
    let id = '';
    const r = new PermissionRouter(base({ holdSubagents: () => true, sendToChat: async (_t: unknown, c: { requestId: string }) => { id = c.requestId; } }));
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, agentId: 'agentA', timeoutSec: 60 });
    await new Promise((res) => setTimeout(res, 10));
    expect(id).not.toBe('');
    r.answer(id, true);
    expect((await p).decision).toBe('allow');
  });

  it('a main-session request (no agentId) is unaffected — still holds and sends a card', async () => {
    let id = '';
    const r = new PermissionRouter(base({ sendToChat: async (_t: unknown, c: { requestId: string }) => { id = c.requestId; } }));
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60 });
    await new Promise((res) => setTimeout(res, 10));
    expect(id).not.toBe('');
    r.answer(id, true);
    expect((await p).decision).toBe('allow');
  });

  it('a policy-allowed sub-agent tool still auto-allows (safe/trust wins over pass-through, no regression)', async () => {
    const send = vi.fn();
    const r = new PermissionRouter(base({ policyDecide: () => ({ decision: 'allow', reason: 'read-only' }), sendToChat: send }));
    const res = await r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Read', input: {}, agentId: 'agentA' });
    expect(res.decision).toBe('allow');
    expect(send).not.toHaveBeenCalled();
  });

  it('handBack resolves a held request as handback (wire = defer, card = not a timeout)', async () => {
    let id = '';
    const r = new PermissionRouter(base({ holdSubagents: () => true, sendToChat: async (_t: unknown, c: { requestId: string }) => { id = c.requestId; } }));
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, agentId: 'agentA', timeoutSec: 60 });
    await new Promise((res) => setTimeout(res, 10));
    expect(r.handBack(id)).toBe(true);
    expect((await p).decision).toBe('handback');
  });

  it('handBack on an unknown/settled request reports false instead of inventing a decision', () => {
    const r = new PermissionRouter(base({}));
    expect(r.handBack('nope')).toBe(false);
  });
});

describe('hasPendingFor — the daemon dedupe test for Notification(permission_prompt) (issue #49)', () => {
  it('true while a request for the key is held, false after it resolves', async () => {
    let id = '';
    const r = new PermissionRouter(base({ sendToChat: async (_t: unknown, c: { requestId: string }) => { id = c.requestId; } }));
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, sessionId: 's1', timeoutSec: 60 });
    await new Promise((res) => setTimeout(res, 0));
    expect(r.hasPendingFor({ key: '/w', sessionId: 's1' })).toBe(true);
    r.answer(id, true);
    await p;
    expect(r.hasPendingFor({ key: '/w', sessionId: 's1' })).toBe(false);
  });

  it('sessionId is conservative-wildcard (same rule as cancel): missing side matches, both-set-different does not', async () => {
    const r = new PermissionRouter(base());
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, sessionId: 's1', timeoutSec: 60 });
    await new Promise((res) => setTimeout(res, 0));
    expect(r.hasPendingFor({ key: '/w' })).toBe(true);
    expect(r.hasPendingFor({ key: '/w', sessionId: 's2' })).toBe(false);
    expect(r.hasPendingFor({ key: '/other', sessionId: 's1' })).toBe(false);
    r.cancel({ key: '/w' });
    await p;
  });
});

// Diagnostics: the five paths that return without a card are indistinguishable
// in behaviour from outside (all of them just resolve), which is exactly why the
// reason tag exists. These lock the tags so a refactor cannot silently collapse
// two causes into one — the failure mode is a log that says "not held" without
// saying why, which is what it said before.
describe('PermissionRouter diagnostics', () => {
  const base = (log: Array<{ event: string; fields: Record<string, unknown> }>) => ({
    configuredChats: () => [{ channel: 'telegram', chatId: 'c1' }],
    sendToChat: async () => {},
    isMuted: () => false,
    hasWebClients: () => false,
    hasLocalAnswerPath: () => false,
    policyDecide: () => ({ decision: 'ask' as const }),
    renderCard: () => ({ title: 'T', body: 'B' }),
    graceSec: () => 0,
    log: (event: string, fields: Record<string, unknown>) => { log.push({ event, fields }); },
  });
  const reasons = (log: Array<{ event: string; fields: Record<string, unknown> }>): unknown[] =>
    log.filter((l) => l.event === 'permission.outcome').map((l) => l.fields.reason);

  it('tags a policy auto-allow', async () => {
    const log: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const r = new PermissionRouter({ ...base(log), policyDecide: () => ({ decision: 'allow' as const }) });
    await r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Read', input: {} });
    expect(reasons(log)).toEqual(['policy-allow']);
  });

  it('tags a sub-agent pass-through, and carries the agentId that caused it', async () => {
    const log: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const r = new PermissionRouter(base(log));
    await r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, agentId: 'subA' });
    expect(reasons(log)).toEqual(['subagent-passthrough']);
    expect(log[0].fields.agentId).toBe('subA');
  });

  it('tags a missing answer surface, and records which surfaces were missing', async () => {
    const log: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const r = new PermissionRouter({ ...base(log), configuredChats: () => [] });
    await r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {} });
    expect(reasons(log)).toEqual(['no-answer-surface']);
    expect(log[0].fields).toMatchObject({ chatTargets: 0, webUsable: false, localUsable: false });
  });

  it('distinguishes a local-terminal release from a remote answer', async () => {
    const local: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const r1 = new PermissionRouter(base(local));
    const p1 = r1.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60 });
    await vi.waitFor(() => { expect(reasons(local)).toEqual(['held']); });
    r1.cancel({ key: '/w' });
    await p1;
    expect(local.find((l) => l.event === 'permission.resolved')?.fields.by).toBe('local-terminal');

    const remote: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const r2 = new PermissionRouter(base(remote));
    const p2 = r2.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: {}, timeoutSec: 60 });
    await vi.waitFor(() => { expect(reasons(remote)).toEqual(['held']); });
    const rid = remote.find((l) => l.fields.reason === 'held')!.fields.requestId as string;
    r2.answer(rid, true);
    await p2;
    expect(remote.find((l) => l.event === 'permission.resolved')?.fields.by).toBe('remote');
  });

  // A card that fails to send leaves the request held with one fewer answer
  // surface than the `held` line claimed, and the send was fire-and-forget with
  // `.catch(() => undefined)` — so the single real cause of "the card never
  // arrived" produced no evidence anywhere. That is how an oversized Telegram
  // callback_data (any tool name over 17 chars) stayed invisible.
  it('logs a card that could not be delivered instead of swallowing it', async () => {
    const log: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const r = new PermissionRouter({
      ...base(log),
      sendToChat: async () => { throw new Error('BUTTON_DATA_INVALID'); },
    });
    const p = r.requestPermission({ key: '/w', cwd: '/w', toolName: 'mcp__x__y', input: {}, timeoutSec: 60 });
    await vi.waitFor(() => {
      const fail = log.find((l) => l.event === 'permission.card.undelivered');
      expect(fail).toBeDefined();
      expect(String(fail!.fields.error)).toContain('BUTTON_DATA_INVALID');
      expect(fail!.fields.channel).toBe('telegram');
    });
    const rid = log.find((l) => l.fields.reason === 'held')!.fields.requestId as string;
    r.answer(rid, true);
    await p;
  });

  it('never puts the tool input in the log', async () => {
    const log: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const r = new PermissionRouter(base(log));
    await r.requestPermission({ key: '/w', cwd: '/w', toolName: 'Bash', input: { command: 'echo SUPER_SECRET' }, agentId: 'a' });
    expect(JSON.stringify(log)).not.toContain('SUPER_SECRET');
  });
});
