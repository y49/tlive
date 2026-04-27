// tests/session/local-session-phase.test.ts
// Phase-machine invariants for LocalSession (Spec X §I2, §D8).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSession } from '../../src/session/local-session.js';
import { SessionContext } from '../../src/session/context.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { PermissionBroker } from '../../src/permission/broker.js';
import { FakeRuntime } from './fake-runtime.js';

let root: string;

async function newSession() {
  const ctx = SessionContext.create({
    sessionId: 'sess-ph-1', workdir: '/tmp', workspaceId: 'ws-1', workspaceName: 'ws',
    provider: 'claude',
  });
  const runtime = new FakeRuntime('claude');
  const persistence = new SessionPersistence(root);
  await persistence.init();
  const broker = new PermissionBroker();
  return new LocalSession({ ctx, runtime, persistence, broker });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tlive-phase-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('LocalSession phase machine', () => {
  it('starts in constructed', async () => {
    expect((await newSession()).lifecyclePhase).toBe('constructed');
  });

  it('prepare → prepared', async () => {
    const s = await newSession();
    await s.prepare({});
    expect(s.lifecyclePhase).toBe('prepared');
  });

  it('attachSink before prepare throws', async () => {
    const s = await newSession();
    expect(() => s.attachSink()).toThrow(/attachSink from constructed/);
  });

  it('prepare twice throws', async () => {
    const s = await newSession();
    await s.prepare({});
    await expect(s.prepare({})).rejects.toThrow(/prepare from prepared/);
  });

  it('attachSink → running', async () => {
    const s = await newSession();
    await s.prepare({});
    s.attachSink();
    expect(s.lifecyclePhase).toBe('running');
  });

  it('attachSink twice throws', async () => {
    const s = await newSession();
    await s.prepare({});
    s.attachSink();
    expect(() => s.attachSink()).toThrow(/attachSink from running/);
  });

  it('stop → terminated', async () => {
    const s = await newSession();
    await s.prepare({});
    s.attachSink();
    await s.stop();
    expect(s.lifecyclePhase).toBe('terminated');
  });
});
