import { describe, it, expect, vi } from 'vitest';
import { PermissionRouter } from '../permission-router';

const chats = () => [{ channel: 'telegram', chatId: 'c1' }];

describe('PermissionRouter (configured-chats, allow/deny/defer)', () => {
  it('defers after timeout (bounded pending)', async () => {
    vi.useFakeTimers();
    const r = new PermissionRouter({ configuredChats: chats, sendToChat: vi.fn().mockResolvedValue(undefined), isMuted: () => false });
    const p = r.requestPermission({ cwd: '/p/foo', toolName: 'Bash', input: {} });
    vi.advanceTimersByTime(251_000);
    expect((await p).decision).toBe('defer');
    vi.useRealTimers();
  });
  it('defers immediately when muted', async () => {
    const send = vi.fn();
    const r = new PermissionRouter({ configuredChats: chats, sendToChat: send, isMuted: () => true });
    expect((await r.requestPermission({ cwd: '/x', toolName: 'Bash', input: {} })).decision).toBe('defer');
    expect(send).not.toHaveBeenCalled();
  });
  it('defers when no chat configured', async () => {
    const r = new PermissionRouter({ configuredChats: () => [], sendToChat: vi.fn(), isMuted: () => false });
    expect((await r.requestPermission({ cwd: '/nowhere', toolName: 'Bash', input: {} })).decision).toBe('defer');
  });
  it('allow when answered true', async () => {
    let id = '';
    const r = new PermissionRouter({ configuredChats: chats, sendToChat: async (_t, c) => { id = c.requestId; }, isMuted: () => false });
    const p = r.requestPermission({ cwd: '/p/foo', toolName: 'Bash', input: { cmd: 'ls' } });
    await new Promise((res) => setTimeout(res, 0));
    r.answer(id, true);
    expect((await p).decision).toBe('allow');
  });
  it('deny when answered false', async () => {
    let id = '';
    const r = new PermissionRouter({ configuredChats: chats, sendToChat: async (_t, c) => { id = c.requestId; }, isMuted: () => false });
    const p = r.requestPermission({ cwd: '/p/foo', toolName: 'Write', input: {} });
    await new Promise((res) => setTimeout(res, 0));
    r.answer(id, false);
    expect((await p).decision).toBe('deny');
  });
});
