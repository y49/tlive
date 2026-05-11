import { describe, it, expect } from 'vitest';
import type { IMAdapter, IncomingEnvelope, OutgoingMessage } from '../../src/kernel/contracts/im-adapter';

class MockIMAdapter implements IMAdapter {
  readonly channel = 'telegram' as const;
  private inboundHandler?: (env: IncomingEnvelope) => void;
  private connected: 'connected' | 'idle' | 'failed' = 'idle';

  async start(): Promise<void> { this.connected = 'connected'; }
  async stop(): Promise<void> { this.connected = 'idle'; }
  async send(_out: OutgoingMessage): Promise<{ messageId: string }> {
    return { messageId: 'msg-1' };
  }
  async edit(_id: string, _out: OutgoingMessage): Promise<void> {}
  onInbound(handler: (env: IncomingEnvelope) => void): void {
    this.inboundHandler = handler;
  }
  isConnected(): 'connected' | 'idle' | 'failed' { return this.connected; }
  // test helper
  simulateInbound(env: IncomingEnvelope) { this.inboundHandler?.(env); }
}

describe('IMAdapter contract', () => {
  it('start/stop are idempotent', async () => {
    const a = new MockIMAdapter();
    await a.start(); await a.start();
    expect(a.isConnected()).toBe('connected');
    await a.stop(); await a.stop();
    expect(a.isConnected()).toBe('idle');
  });

  it('send returns a messageId', async () => {
    const a = new MockIMAdapter();
    const r = await a.send({ kind: 'text', text: 'hi' });
    expect(r.messageId).toBeDefined();
  });

  it('edit accepts string messageId', async () => {
    const a = new MockIMAdapter();
    await expect(a.edit('msg-1', { kind: 'text', text: 'updated' })).resolves.toBeUndefined();
  });

  it('onInbound delivers envelopes', () => {
    const a = new MockIMAdapter();
    let received: IncomingEnvelope | null = null;
    a.onInbound((env) => { received = env; });
    a.simulateInbound({
      channel: 'telegram', chatId: '1', userId: '2', messageId: '3',
      text: 'hello', ts: Date.now(),
    });
    expect(received).not.toBeNull();
    expect(received!.text).toBe('hello');
  });

  it('isConnected returns one of three values', () => {
    const a = new MockIMAdapter();
    expect(['connected', 'idle', 'failed']).toContain(a.isConnected());
  });
});
