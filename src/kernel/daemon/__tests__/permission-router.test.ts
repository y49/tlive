import { describe, it, expect, vi } from 'vitest';
import { PermissionRouter } from '../permission-router';

const chats = () => [{ channel: 'telegram', chatId: 'c1' }];
const askAll = () => ({ decision: 'ask' as const });
const card = () => ({ title: 't', body: 'b' });
const base = (over = {}) => ({
  configuredChats: chats, isMuted: () => false,
  sendToChat: vi.fn().mockResolvedValue(undefined),
  policyDecide: askAll, renderCard: card, ...over,
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
