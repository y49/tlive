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
      edit: vi.fn(async (msgId: string, chatId: string, text: string) => { edited.push({ msgId, text }); }),
      sendCard: vi.fn(async (req: any) => { sent.push({ ...req, kind: 'card' }); return `m${sent.length}`; }),
      updateCard: vi.fn(async (msgId: string, chatId: string, card: any) => { edited.push({ msgId, card }); }),
    },
  };
}

const tgTarget = { channelType: 'telegram' as const, chatId: 'c1', role: 'primary' as const };
const fsTarget = { channelType: 'feishu' as const, chatId: 'c1', role: 'primary' as const };

const baseState = () => initialHudState({
  sessionShortId: 'a', workspaceName: 'w', provider: 'claude',
  model: 'claude-sonnet-4-5', modelMaxContext: 200_000, turnNumber: 1,
  startedAtMs: 0, costSession: 0,
});

describe('ReplyDocument — Telegram', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('start() sends 2 messages: reply head + detail card', async () => {
    const { adapter, sent } = makeFakeAdapter();
    const eq = new EditQueue(TG_OPTS);
    const doc = new ReplyDocument(adapter as any, tgTarget, eq, baseState());
    await doc.start();
    await vi.runAllTimersAsync();
    expect(sent.length).toBe(2);
    expect(sent[0].chatId).toBe('c1');
    expect(sent[0].parseMode).toBe('html');
    expect(sent[0].replyToMessageId).toBeUndefined();
    // v3.2.1: detail no longer has replyToMessageId — avoids Telegram quote bubble
    // duplicating the parent reply's content above the detail
    expect(sent[1].replyToMessageId).toBeUndefined();
    expect(sent[1].text).toContain('<pre><code>');
  });

  it('setBody → edits reply (m1) only, not detail (m2)', async () => {
    const { adapter, edited } = makeFakeAdapter();
    const eq = new EditQueue(TG_OPTS);
    const doc = new ReplyDocument(adapter as any, tgTarget, eq, baseState());
    await doc.start();
    await vi.runAllTimersAsync();
    doc.setBody('Hello world');
    doc.scheduler.schedule('event', 1);
    await vi.advanceTimersByTimeAsync(300);
    const m1Edits = edited.filter((e) => e.msgId === 'm1');
    const m2Edits = edited.filter((e) => e.msgId === 'm2');
    expect(m1Edits.length).toBeGreaterThanOrEqual(1);
    expect(m2Edits.length).toBeGreaterThanOrEqual(1);
    expect(m1Edits[0].text).toContain('Hello world');
    expect(m2Edits[0].text).not.toContain('Hello world');
    expect(m2Edits[0].text).toContain('<pre><code>');
  });

  it('freeze() edits both messages with frozen state', async () => {
    const { adapter, edited } = makeFakeAdapter();
    const eq = new EditQueue(TG_OPTS);
    const doc = new ReplyDocument(adapter as any, tgTarget, eq, baseState());
    await doc.start();
    await vi.runAllTimersAsync();
    await doc.freeze({ ...baseState(), isFrozen: true, durationMs: 12_300 });
    await vi.runAllTimersAsync();
    const m1Last = edited.filter((e) => e.msgId === 'm1').pop();
    const m2Last = edited.filter((e) => e.msgId === 'm2').pop();
    expect(m1Last!.text).toContain('done');
    expect(m2Last!.text).toContain('<pre><code>');
  });

  it('body >4096 chars → splits into reply chunks (replyTo head)', async () => {
    const { adapter, sent } = makeFakeAdapter();
    const eq = new EditQueue(TG_OPTS);
    const doc = new ReplyDocument(adapter as any, tgTarget, eq, baseState());
    await doc.start();
    await vi.runAllTimersAsync();

    const bigBody = 'x'.repeat(5000);
    doc.setBody(bigBody);
    doc.scheduler.schedule('event', 1);
    await vi.advanceTimersByTimeAsync(300);
    // sent.length now > 2 — initial 2 (reply head + detail) plus N overflow chunks
    expect(sent.length).toBeGreaterThan(2);
    const overflowChunks = sent.slice(2);
    for (const c of overflowChunks) {
      expect(c.replyToMessageId).toBe('m1');
      expect(c.parseMode).toBe('html');
    }
  });
});

describe('ReplyDocument — Feishu', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('start() sends 1 lark card', async () => {
    const { adapter, sent } = makeFakeAdapter();
    const eq = new EditQueue({ refillMs: 100, capacity: 50 });
    const doc = new ReplyDocument(adapter as any, fsTarget, eq, baseState());
    await doc.start();
    await vi.runAllTimersAsync();
    expect(sent.length).toBe(1);
    expect(sent[0].kind).toBe('card');
  });

  it('setBody → updateCard once', async () => {
    const { adapter, edited } = makeFakeAdapter();
    const eq = new EditQueue({ refillMs: 100, capacity: 50 });
    const doc = new ReplyDocument(adapter as any, fsTarget, eq, baseState());
    await doc.start();
    await vi.runAllTimersAsync();
    doc.setBody('Hello world');
    doc.scheduler.schedule('event', 1);
    await vi.advanceTimersByTimeAsync(300);
    expect(edited.length).toBeGreaterThanOrEqual(1);
    expect(edited[0].card).toBeDefined();
  });
});
