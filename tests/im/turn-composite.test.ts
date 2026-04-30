import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TurnComposite } from '../../src/im/turn-composite.js';
import { EditQueue } from '../../src/im/reply-document/edit-queue.js';
import { initialHudState } from '../../src/im/hud/state.js';

function makeFakeAdapter() {
  const sent: any[] = [];
  const edited: any[] = [];
  return {
    sent, edited,
    adapter: {
      send: vi.fn(async (req: any) => { sent.push(req); return `m${sent.length}`; }),
      edit: vi.fn(async (msgId: string, chatId: string, text: string) => { edited.push({ msgId, text }); }),
      sendCard: vi.fn(async (req: any) => { sent.push({ ...req, kind: 'card' }); return `m${sent.length}`; }),
      updateCard: vi.fn(async (msgId: string, chatId: string, card: any) => { edited.push({ msgId, card }); }),
    },
  };
}

const target = { channelType: 'telegram' as const, chatId: 'c1', role: 'primary' as const };

describe('TurnComposite — integration', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('start → 两次 send 占位 message (v3.2 dual: reply head + detail card)', async () => {
    const { adapter, sent } = makeFakeAdapter();
    const eq = new EditQueue({ refillMs: 2000, capacity: 5 });
    const state = initialHudState({
      sessionShortId: 'a', workspaceName: 'w', provider: 'claude',
      model: 'opus-4-6', modelMaxContext: 200_000, turnNumber: 1,
      startedAtMs: 0, costSession: 0,
    });
    const tc = new TurnComposite(adapter as any, target, eq, state);
    await tc.start();
    await vi.runAllTimersAsync();
    // v3.2.1: ReplyDocument.start sends 2 messages on telegram — reply head (m1)
    // and detail card (m2, adjacent — NO replyTo to avoid Telegram quote bubble).
    // Detail contains <pre><code>.
    expect(sent.length).toBe(2);
    expect(sent[1].replyToMessageId).toBeUndefined();
  });

  it('ingestEvent assistant_text_delta 累加 body 并 schedule edit', async () => {
    const { adapter, edited } = makeFakeAdapter();
    const eq = new EditQueue({ refillMs: 2000, capacity: 5 });
    const state = initialHudState({
      sessionShortId: 'a', workspaceName: 'w', provider: 'claude',
      model: 'opus-4-6', modelMaxContext: 200_000, turnNumber: 1,
      startedAtMs: 0, costSession: 0,
    });
    const tc = new TurnComposite(adapter as any, target, eq, state);
    await tc.start();
    await vi.runAllTimersAsync();

    tc.ingestEvent({ kind: 'assistant_text_delta', turnId: 't1', text: 'Hello ', partial: true });
    tc.ingestEvent({ kind: 'assistant_text_delta', turnId: 't1', text: 'world', partial: true });
    await vi.advanceTimersByTimeAsync(300);
    // v3.2: body lives in m1 (reply head); m2 is detail card with no body.
    const m1Edit = edited.find((e) => e.msgId === 'm1');
    expect(m1Edit).toBeDefined();
    expect(m1Edit!.text).toContain('Hello world');
  });

  it('turn_end 调 freeze 并 stop scheduler', async () => {
    const { adapter, edited } = makeFakeAdapter();
    const eq = new EditQueue({ refillMs: 2000, capacity: 5 });
    const state = initialHudState({
      sessionShortId: 'a', workspaceName: 'w', provider: 'claude',
      model: 'opus-4-6', modelMaxContext: 200_000, turnNumber: 1,
      startedAtMs: 0, costSession: 0,
    });
    const tc = new TurnComposite(adapter as any, target, eq, state);
    await tc.start();
    await vi.runAllTimersAsync();
    tc.ingestEvent({
      kind: 'turn_end', turnId: 't1', durationMs: 12_300,
      costUsd: 0.04, tokensIn: 1000, tokensOut: 500,
    });
    await vi.runAllTimersAsync();
    // v3.2: 'done' banner lives in m1 (reply head); m2 is detail card.
    const m1Last = edited.filter((e) => e.msgId === 'm1').pop();
    expect(m1Last).toBeDefined();
    expect(m1Last!.text).toContain('done');
  });
});
