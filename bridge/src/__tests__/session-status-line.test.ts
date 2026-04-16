import { describe, it, expect, vi } from 'vitest';
import { SessionStatusLine, type StatusPhase, type StatusPayload } from '../engine/session-status-line.js';

type SendFn = (payload: StatusPayload) => Promise<string>;
type EditFn = (messageId: string, payload: StatusPayload) => Promise<boolean>;

describe('SessionStatusLine', () => {
  it('sends first message on first phase update', async () => {
    const send = vi.fn<SendFn>(async () => 'msg-1');
    const edit = vi.fn<EditFn>(async () => true);
    const line = new SessionStatusLine({ send, edit, throttleMs: 50 });

    await line.setPhase({ kind: 'thinking' });
    await new Promise((r) => setTimeout(r, 80));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ phase: 'thinking' });
  });

  it('edits rather than sends on subsequent phase updates', async () => {
    const send = vi.fn<SendFn>(async () => 'msg-1');
    const edit = vi.fn<EditFn>(async () => true);
    const line = new SessionStatusLine({ send, edit, throttleMs: 50 });

    await line.setPhase({ kind: 'thinking' });
    await new Promise((r) => setTimeout(r, 80));

    await line.setPhase({ kind: 'reading', target: 'a.ts' });
    await new Promise((r) => setTimeout(r, 80));

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0][1]).toMatchObject({ phase: 'reading', target: 'a.ts' });
  });

  it('throttles rapid phase updates', async () => {
    const send = vi.fn<SendFn>(async () => 'msg-1');
    const edit = vi.fn<EditFn>(async () => true);
    const line = new SessionStatusLine({ send, edit, throttleMs: 100 });

    await line.setPhase({ kind: 'thinking' });
    await new Promise((r) => setTimeout(r, 120));

    // Rapid updates within throttle window
    await line.setPhase({ kind: 'reading', target: 'a.ts' });
    await line.setPhase({ kind: 'reading', target: 'b.ts' });
    await line.setPhase({ kind: 'reading', target: 'c.ts' });
    await new Promise((r) => setTimeout(r, 150));

    // Only one edit happens (last state wins)
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0][1]).toMatchObject({ target: 'c.ts' });
  });

  it('falls back to send when edit fails', async () => {
    const send = vi.fn<SendFn>(async () => 'msg-new');
    const edit = vi.fn<EditFn>(async () => false);
    const line = new SessionStatusLine({ send, edit, throttleMs: 50 });

    await line.setPhase({ kind: 'thinking' });
    await new Promise((r) => setTimeout(r, 80));

    await line.setPhase({ kind: 'done', durationMs: 1000 });
    await new Promise((r) => setTimeout(r, 80));

    expect(send).toHaveBeenCalledTimes(2);  // initial + fallback after edit failure
  });
});
