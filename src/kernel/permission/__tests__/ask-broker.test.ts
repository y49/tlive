import { describe, it, expect } from 'vitest';
import { AskBroker } from '../ask-broker';

describe('AskBroker', () => {
  it('round-trip: ask + answer', async () => {
    const b = new AskBroker();
    let pushed: string | null = null;
    b.onRequest((req) => { pushed = req.requestId; });
    const promise = b.ask({ pid: 1, question: 'what?', timeoutSec: 60 });
    expect(pushed).not.toBeNull();
    b.answer(pushed!, 'yes');
    const r = await promise;
    expect(r).toBe('yes');
  });

  it('times out with "(timeout)" string', async () => {
    const b = new AskBroker();
    b.onRequest(() => { /* never answer */ });
    const r = await b.ask({ pid: 1, question: 'X', timeoutSec: 0.05 }); // 50ms
    expect(r).toBe('(timeout)');
  });
});
