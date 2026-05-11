import { describe, it, expect } from 'vitest';
import type { RuntimeAdapter, RuntimeEvent } from '../../src/kernel/contracts/runtime-adapter';
import type { PermissionHandler } from '../../src/kernel/contracts/runtime-adapter';

class MockRuntime implements RuntimeAdapter {
  readonly provider = 'mock';
  private permHandler?: PermissionHandler;
  async start(_opts: { workspaceDir: string; resumeProviderSessionId?: string }) {
    return { providerSessionId: 'mock-sid' };
  }
  async sendUser(_text: string) {}
  async interrupt() {}
  async stop() {}
  async *events(): AsyncIterable<RuntimeEvent> {
    yield { kind: 'session_ready', providerSessionId: 'mock-sid' };
    yield { kind: 'turn_end' };
  }
  installPermissionHandler(handler: PermissionHandler) {
    this.permHandler = handler;
  }
}

describe('RuntimeAdapter contract', () => {
  it('start returns providerSessionId', async () => {
    const r = new MockRuntime();
    const out = await r.start({ workspaceDir: '/tmp' });
    expect(out.providerSessionId).toBe('mock-sid');
  });

  it('events yields RuntimeEvent items', async () => {
    const r = new MockRuntime();
    await r.start({ workspaceDir: '/tmp' });
    const evs: RuntimeEvent[] = [];
    for await (const e of r.events()) evs.push(e);
    expect(evs).toHaveLength(2);
    expect(evs[0].kind).toBe('session_ready');
  });

  it('installPermissionHandler accepts function', () => {
    const r = new MockRuntime();
    expect(() =>
      r.installPermissionHandler(async () => true),
    ).not.toThrow();
  });

  it('start with resume passes through providerSessionId', async () => {
    const r = new MockRuntime();
    const out = await r.start({ workspaceDir: '/tmp', resumeProviderSessionId: 'old-sid' });
    expect(out.providerSessionId).toBeDefined();
  });
});
