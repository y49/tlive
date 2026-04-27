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
let session: LocalSession | null = null;

async function newSession(): Promise<LocalSession> {
  const ctx = SessionContext.create({
    sessionId: 'sess-ph-1', workdir: '/tmp', workspaceId: 'ws-1', workspaceName: 'ws',
    provider: 'claude',
  });
  const runtime = new FakeRuntime('claude');
  const persistence = new SessionPersistence(root);
  await persistence.init();
  const broker = new PermissionBroker();
  const s = new LocalSession({ ctx, runtime, persistence, broker });
  session = s;
  return s;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tlive-phase-'));
  session = null;
});
afterEach(async () => {
  // Drain any in-flight trackedSave from attachSink before nuking root.
  // stop() awaits pendingSaves; flushPendingPersistence() is safe for all
  // phases (including 'constructed'/'prepared' where no save was fired).
  if (session) {
    const phase = session.lifecyclePhase;
    if (phase === 'running') {
      await session.stop().catch(() => undefined);
    } else if (phase !== 'terminated') {
      // 'constructed' or 'prepared': no trackedSave fired yet, but call
      // flush defensively so any future-phase changes stay race-free.
      await session.flushPendingPersistence().catch(() => undefined);
    }
  }
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
