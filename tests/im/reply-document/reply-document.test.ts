import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReplyDocument } from '../../../src/im/reply-document/reply-document.js';
import { EditQueue } from '../../../src/im/reply-document/edit-queue.js';
import { initialHudState } from '../../../src/im/hud/state.js';

const TG_OPTS = { refillMs: 2000, capacity: 5 };

function makeFakeAdapter() {
  const sent: any[] = [];
  const edited: any[] = [];
  return {
    sent, edited,
    adapter: {
      send: vi.fn(async (req: any) => { sent.push(req); return `m${sent.length}`; }),
      edit: vi.fn(async (msgId: string, chatId: string, text: string) => { edited.push({ msgId, chatId, text }); }),
      sendCard: vi.fn(async (req: any) => { sent.push({ ...req, kind: 'card' }); return `m${sent.length}`; }),
      updateCard: vi.fn(async (msgId: string, chatId: string, card: any) => { edited.push({ msgId, chatId, card }); }),
    },
  };
}

describe('ReplyDocument — Telegram', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('start() 发占位 message 并记录 msgId', async () => {
    const { adapter, sent } = makeFakeAdapter();
    const eq = new EditQueue(TG_OPTS);
    const target = { channelType: 'telegram' as const, chatId: 'c1', role: 'primary' as const };
    const state = initialHudState({
      sessionShortId: 'a', workspaceName: 'w', provider: 'claude',
      model: 'opus-4-6', modelMaxContext: 200_000, turnNumber: 1,
      startedAtMs: 0, costSession: 0,
    });
    const doc = new ReplyDocument(adapter as any, target, eq, state);
    await doc.start();
    await vi.runAllTimersAsync();
    expect(sent.length).toBe(1);
    expect(sent[0].chatId).toBe('c1');
    expect(sent[0].parseMode).toBe('html');
  });

  it('setBody → schedule edit', async () => {
    const { adapter, edited } = makeFakeAdapter();
    const eq = new EditQueue(TG_OPTS);
    const target = { channelType: 'telegram' as const, chatId: 'c1', role: 'primary' as const };
    const state = initialHudState({
      sessionShortId: 'a', workspaceName: 'w', provider: 'claude',
      model: 'opus-4-6', modelMaxContext: 200_000, turnNumber: 1,
      startedAtMs: 0, costSession: 0,
    });
    const doc = new ReplyDocument(adapter as any, target, eq, state);
    await doc.start();
    await vi.runAllTimersAsync();
    doc.setBody('Hello world');
    doc.scheduler.schedule('event', 1);
    await vi.advanceTimersByTimeAsync(300);
    expect(edited.length).toBeGreaterThanOrEqual(1);
    expect(edited[0].text).toContain('Hello world');
  });

  it('freeze() 把 banner 切到 done 并 stop scheduler', async () => {
    const { adapter, edited } = makeFakeAdapter();
    const eq = new EditQueue(TG_OPTS);
    const target = { channelType: 'telegram' as const, chatId: 'c1', role: 'primary' as const };
    const state = initialHudState({
      sessionShortId: 'a', workspaceName: 'w', provider: 'claude',
      model: 'opus-4-6', modelMaxContext: 200_000, turnNumber: 1,
      startedAtMs: 0, costSession: 0,
    });
    const doc = new ReplyDocument(adapter as any, target, eq, state);
    await doc.start();
    await vi.runAllTimersAsync();
    await doc.freeze({ ...state, isFrozen: true, durationMs: 12_300 });
    await vi.runAllTimersAsync();
    const lastEdit = edited[edited.length - 1];
    expect(lastEdit.text).toContain('done');
  });
});
