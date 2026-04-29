import { describe, it, expect } from 'vitest';
import { TelegramHudPanel } from '../../../src/im/hud/telegram-panel.js';
import { FeishuHudPanel } from '../../../src/im/hud/feishu-panel.js';
import { initialHudState } from '../../../src/im/hud/state.js';
import { FakeAdapter } from '../fake-adapter.js';

function baseState() {
  return initialHudState({
    sessionShortId: 'abc',
    workspaceName: 'w',
    provider: 'claude',
    model: 'opus-4-6',
    modelMaxContext: 200_000,
    turnNumber: 1,
    startedAtMs: 0,
    costSession: 0,
  });
}

describe('TelegramHudPanel', () => {
  it('send calls adapter.send with HTML parseMode + returns msgId', async () => {
    const adapter = new FakeAdapter('telegram');
    const panel = new TelegramHudPanel(adapter, { chatId: 'c1', role: 'primary', channelType: 'telegram' });
    const id = await panel.send(baseState());
    expect(id).toBe('m-1');
    const call = adapter.calls[0];
    expect(call.kind).toBe('send');
    expect(call.args.parseMode).toBe('html');
    expect(call.args.chatId).toBe('c1');
    expect(call.args.text).toMatch(/^<pre><code>/);
  });

  it('update calls adapter.edit with new state', async () => {
    const adapter = new FakeAdapter('telegram');
    const panel = new TelegramHudPanel(adapter, { chatId: 'c1', role: 'primary', channelType: 'telegram' });
    const msgId = await panel.send(baseState());
    await panel.update(msgId, { ...baseState(), contextUsedTok: 1000 });
    expect(adapter.calls[1].kind).toBe('edit');
    expect(adapter.calls[1].args.messageId).toBe(msgId);
    expect(adapter.calls[1].args.parseMode).toBe('html');
  });

  it('update is a no-op when content hash matches last render', async () => {
    const adapter = new FakeAdapter('telegram');
    const panel = new TelegramHudPanel(adapter, { chatId: 'c1', role: 'primary', channelType: 'telegram' });
    const id = await panel.send(baseState());
    await panel.update(id, baseState());
    await panel.update(id, baseState());
    expect(adapter.calls.filter(c => c.kind === 'edit')).toHaveLength(0);
  });

  it('freeze calls adapter.edit once with isFrozen state', async () => {
    const adapter = new FakeAdapter('telegram');
    const panel = new TelegramHudPanel(adapter, { chatId: 'c1', role: 'primary', channelType: 'telegram' });
    const id = await panel.send(baseState());
    await panel.freeze(id, { ...baseState(), isFrozen: true });
    const editCall = adapter.calls.find(c => c.kind === 'edit');
    expect(editCall).toBeTruthy();
    expect((editCall!.args.text as string)).toMatch(/done/i);
  });

  it('swallows adapter.edit errors silently (per I6)', async () => {
    const adapter = new FakeAdapter('telegram');
    adapter.edit = async () => { throw new Error('Bad Request: message can\'t be edited'); };
    const panel = new TelegramHudPanel(adapter, { chatId: 'c1', role: 'primary', channelType: 'telegram' });
    const id = await panel.send(baseState());
    await expect(panel.update(id, { ...baseState(), contextUsedTok: 1 })).resolves.toBeUndefined();
    await expect(panel.freeze(id, { ...baseState(), isFrozen: true })).resolves.toBeUndefined();
  });
});

describe('FeishuHudPanel', () => {
  it('send calls adapter.sendCard with structured payload + returns msgId', async () => {
    const adapter = new FakeAdapter('feishu');
    const panel = new FeishuHudPanel(adapter, { chatId: 'c1', role: 'primary', channelType: 'feishu' });
    const id = await panel.send(baseState());
    expect(id).toBe('m-1');
    const call = adapter.calls[0];
    expect(call.kind).toBe('sendCard');
    expect((call.args.card as any).schema).toBe('2.0');
  });

  it('update calls adapter.updateCard', async () => {
    const adapter = new FakeAdapter('feishu');
    const panel = new FeishuHudPanel(adapter, { chatId: 'c1', role: 'primary', channelType: 'feishu' });
    const id = await panel.send(baseState());
    await panel.update(id, { ...baseState(), contextUsedTok: 2000 });
    expect(adapter.calls[1].kind).toBe('updateCard');
  });

  it('update dedupes by content hash', async () => {
    const adapter = new FakeAdapter('feishu');
    const panel = new FeishuHudPanel(adapter, { chatId: 'c1', role: 'primary', channelType: 'feishu' });
    const id = await panel.send(baseState());
    await panel.update(id, baseState());
    expect(adapter.calls.filter(c => c.kind === 'updateCard')).toHaveLength(0);
  });

  it('freeze sets isFrozen + emits one updateCard', async () => {
    const adapter = new FakeAdapter('feishu');
    const panel = new FeishuHudPanel(adapter, { chatId: 'c1', role: 'primary', channelType: 'feishu' });
    const id = await panel.send(baseState());
    await panel.freeze(id, { ...baseState(), isFrozen: true });
    const update = adapter.calls.find(c => c.kind === 'updateCard');
    expect(update).toBeTruthy();
    expect((update!.args.card as any).header.template).toBe('grey');
  });

  it('throws if adapter has no sendCard / updateCard', async () => {
    const adapter = new FakeAdapter('feishu');
    delete (adapter as any).sendCard;
    const panel = new FeishuHudPanel(adapter, { chatId: 'c1', role: 'primary', channelType: 'feishu' });
    await expect(panel.send(baseState())).rejects.toThrow(/sendCard/);
  });
});
