import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionRetry, RETRY_PROMPT } from '../session-retry.js';

afterEach(() => vi.useRealTimers());
const chat = [{ channel: 'feishu', chatId: 'chat-1' }];
function setup(enabled = true) {
  const inject = vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn();
  const alive = new Set(['a', 'b']);
  const retry = new SessionRetry({ enabled, maxAttempts: 3 }, {
    canRetry: key => alive.has(key), inject, notify,
  });
  return { retry, inject, notify, alive };
}

describe('SessionRetry', () => {
  it('cancels an old auto retry immediately when a different permanent error arrives', async () => {
    vi.useFakeTimers();
    const { retry, inject } = setup();
    const old = retry.failure('a', true, chat, 'timeout');
    retry.noteFailure('a', 'SSL certificate hostname mismatch');
    await vi.advanceTimersByTimeAsync(6000);
    expect(inject).not.toHaveBeenCalled();
    expect(await retry.answer(old.id, 'feishu', 'chat-1')).toBe('stale');
    retry.stop();
  });

  it('preserves the visible action for duplicate errors but replaces a consumed action', async () => {
    const {retry} = setup(false);
    const first = retry.failure('a', false, chat, 'TLS');
    retry.noteFailure('a', 'TLS');
    const duplicate = retry.failure('a', false, chat, 'TLS');
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.newAction).toBe(false);
    expect(await retry.answer(first.id, 'feishu', 'chat-1')).toBe('sent');
    const afterManual = retry.failure('a', false, chat, 'TLS');
    expect(afterManual.id).not.toBe(first.id);
    expect(afterManual.newAction).toBe(true);
    retry.stop();
  });
  it('uses bounded backoff and stops after three automatic attempts', async () => {
    vi.useFakeTimers();
    const { retry, inject } = setup();
    for (const delay of [5000, 15000, 30000]) {
      retry.failure('a', true, chat);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(inject).toHaveBeenCalledTimes([5000, 15000, 30000].indexOf(delay));
      await vi.advanceTimersByTimeAsync(1);
      retry.prompt('a', RETRY_PROMPT);
    }
    const exhausted = retry.failure('a', true, chat);
    await vi.advanceTimersByTimeAsync(60000);
    expect(inject).toHaveBeenCalledTimes(3);
    expect(exhausted.attempts).toBe(3);
    expect(exhausted.nextDelaySec).toBeUndefined();
    retry.stop();
  });

  it('does not auto-retry permanent failures or opt-in-disabled sessions', async () => {
    vi.useFakeTimers();
    const one = setup();
    one.retry.failure('a', false, chat);
    const two = setup(false);
    two.retry.failure('a', true, chat);
    await vi.advanceTimersByTimeAsync(60000);
    expect(one.inject).not.toHaveBeenCalled();
    expect(two.inject).not.toHaveBeenCalled();
    one.retry.stop(); two.retry.stop();
  });

  it('targets the selected project and consumes concurrent callbacks once', async () => {
    const { retry, inject } = setup(false);
    const a = retry.failure('a', true, chat);
    retry.failure('b', true, chat);
    expect(await retry.answer(a.id, 'feishu', 'wrong-chat')).toBe('stale');
    const results = await Promise.all([retry.answer(a.id, 'feishu', 'chat-1'), retry.answer(a.id, 'feishu', 'chat-1')]);
    expect(results.sort()).toEqual(['sent', 'stale']);
    expect(inject).toHaveBeenCalledExactlyOnceWith('a', RETRY_PROMPT);
    retry.stop();
  });

  it('invalidates old cards on new failure, manual prompt, success and shutdown', async () => {
    vi.useFakeTimers();
    const { retry, inject } = setup();
    const old = retry.failure('a', true, chat, 'timeout');
    const current = retry.failure('a', false, chat, 'TLS');
    expect(await retry.answer(old.id, 'feishu', 'chat-1')).toBe('stale');
    retry.prompt('a', 'do something else');
    expect(await retry.answer(current.id, 'feishu', 'chat-1')).toBe('stale');
    const done = retry.failure('a', true, chat);
    retry.complete('a');
    expect(await retry.answer(done.id, 'feishu', 'chat-1')).toBe('stale');
    const stopped = retry.failure('b', true, chat);
    retry.stop();
    expect(await retry.answer(stopped.id, 'feishu', 'chat-1')).toBe('stale');
    await vi.advanceTimersByTimeAsync(60000);
    expect(inject).not.toHaveBeenCalled();
  });

  it('reports unsupported sessions and injection failures without throwing', async () => {
    const { retry, inject, alive } = setup(false);
    alive.delete('a');
    const plain = retry.failure('a', true, chat);
    expect(plain.canRetry).toBe(false);
    expect(await retry.answer(plain.id, 'feishu', 'chat-1')).toBe('unavailable');
    const other = retry.failure('b', true, chat);
    inject.mockRejectedValueOnce(new Error('socket closed'));
    expect(await retry.answer(other.id, 'feishu', 'chat-1')).toBe('failed');
    expect(await retry.answer(other.id, 'feishu', 'chat-1')).toBe('stale');
    retry.stop();
  });
});
