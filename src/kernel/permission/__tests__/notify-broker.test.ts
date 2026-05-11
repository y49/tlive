import { describe, it, expect, vi } from 'vitest';
import { NotifyBroker } from '../notify-broker';

describe('NotifyBroker', () => {
  it('pushes to all bound chats', async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const b = new NotifyBroker({
      workspaceForPid: () => 'ws-1',
      chatsForWorkspace: () => [{ channel: 'telegram', chatId: 'c1' }, { channel: 'feishu', chatId: 'c2' }],
      sendToChat: async (t, m) => { sent.push({ chatId: t.chatId, text: m.text }); },
    });
    await b.push({ pid: 1, message: 'hello', level: 'info' });
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.chatId).sort()).toEqual(['c1', 'c2']);
  });

  it('no-op when pid has no workspace', async () => {
    const sender = vi.fn();
    const b = new NotifyBroker({
      workspaceForPid: () => undefined,
      chatsForWorkspace: () => [{ channel: 'telegram', chatId: 'c1' }],
      sendToChat: sender as never,
    });
    await b.push({ pid: 999, message: 'X', level: 'info' });
    expect(sender).not.toHaveBeenCalled();
  });
});
