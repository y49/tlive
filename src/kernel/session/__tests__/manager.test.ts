import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../manager';
import type { RuntimeAdapter, RuntimeEvent, PermissionHandler } from '../../contracts/runtime-adapter';

class StubRuntime implements RuntimeAdapter {
  readonly provider = 'stub';
  startCalls: Array<{ workspaceDir: string; resumeProviderSessionId?: string }> = [];
  async start(opts: { workspaceDir: string; resumeProviderSessionId?: string }) {
    this.startCalls.push(opts);
    return { providerSessionId: opts.resumeProviderSessionId ?? 'sdk-id-new' };
  }
  async sendUser(_t: string) {}
  async interrupt() {}
  async stop() {}
  async *events(): AsyncIterable<RuntimeEvent> { return; }
  installPermissionHandler(_h: PermissionHandler) {}
}

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'tlive-sess-')); });

describe('SessionManager double-sessionId model', () => {
  it('create returns tlive sessionId distinct from provider id', async () => {
    const mgr = new SessionManager({ home: tmp, runtimeFactory: () => new StubRuntime() });
    const s = await mgr.create({ workspaceDir: '/tmp/foo', provider: 'stub' });
    expect(s.tliveSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.providerSessionId).toBe('sdk-id-new');
    expect(s.tliveSessionId).not.toBe(s.providerSessionId);
  });

  it('persists providerSessionId across restart', async () => {
    const mgr1 = new SessionManager({ home: tmp, runtimeFactory: () => new StubRuntime() });
    const s = await mgr1.create({ workspaceDir: '/tmp/foo', provider: 'stub' });
    const tliveId = s.tliveSessionId;
    const providerId = s.providerSessionId;

    // simulate restart
    const stub = new StubRuntime();
    const mgr2 = new SessionManager({ home: tmp, runtimeFactory: () => stub });
    await mgr2.resume(tliveId);

    expect(stub.startCalls[0].resumeProviderSessionId).toBe(providerId);
  });

  it('resume passes correct providerSessionId to RuntimeAdapter (regression for 5/11 bug)', async () => {
    const mgr = new SessionManager({ home: tmp, runtimeFactory: () => new StubRuntime() });
    const s = await mgr.create({ workspaceDir: '/tmp/foo', provider: 'stub' });
    const stub = new StubRuntime();
    const mgr2 = new SessionManager({ home: tmp, runtimeFactory: () => stub });
    await mgr2.resume(s.tliveSessionId);

    // CRITICAL: must NOT equal tliveSessionId
    expect(stub.startCalls[0].resumeProviderSessionId).not.toBe(s.tliveSessionId);
    expect(stub.startCalls[0].resumeProviderSessionId).toBe(s.providerSessionId);
  });
});
