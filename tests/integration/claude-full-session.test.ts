// tests/integration/claude-full-session.test.ts
//
// End-to-end Claude session lifecycle (spec §18 row 1):
//   create → sendInput → tool_use → permission request → approve →
//   assistant text → session_complete.
//
// Uses FakeRuntime as the Claude stand-in so the test requires no network
// and exercises the real SessionManager / LocalSession / PermissionBroker
// wiring. Runs in <1s.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionManager } from '../../src/session/manager.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { PermissionBroker } from '../../src/permission/broker.js';
import type { NotificationEvent } from '../../src/runtime/events.js';
import type { PermissionRequest } from '../../src/runtime/types.js';
import { FakeRuntime } from '../session/fake-runtime.js';

async function boot() {
  const home = mkdtempSync(join(tmpdir(), 'tlive-claude-full-'));
  const persistence = new SessionPersistence(join(home, 'sessions'));
  await persistence.init();
  const broker = new PermissionBroker();
  const runtimes: FakeRuntime[] = [];
  const mgr = new SessionManager({
    persistence,
    broker,
    runtimeFactory: (provider) => {
      if (provider !== 'claude') throw new Error('expected claude runtime');
      const r = new FakeRuntime('claude');
      runtimes.push(r);
      return r;
    },
  });
  return { home, mgr, broker, runtimes };
}

describe('integration: claude-full-session', () => {
  let env: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => { env = await boot(); });
  afterEach(async () => {
    await env.mgr.stopAll().catch(() => undefined);
    rmSync(env.home, { recursive: true, force: true });
  });

  it('drives a full Claude turn: create -> input -> tool_use -> approve -> assistant -> complete', async () => {
    const events: NotificationEvent[] = [];
    const permissionDecisions: Array<'allow' | 'deny'> = [];

    const session = await env.mgr.createLocal({
      workspaceId: 'ws-claude',
      provider: 'claude',
      workdir: env.home,
      source: 'cli',
    });
    session.onEvent((e) => events.push(e));
    env.broker.subscribe((ev) => {
      if (ev.kind === 'pending') {
        // IM operator decides: allow.
        env.broker.resolve(session.id, ev.request.id, 'allow', 'tester');
      }
      if (ev.kind === 'resolved') {
        permissionDecisions.push(ev.decision as 'allow' | 'deny');
      }
    });

    const runtime = env.runtimes[0]!;
    expect(runtime.prepared).toBe(true);

    // --- User turn (sendInput) ---
    await session.sendInput('build the user auth flow', 'im');
    expect(runtime.inputs).toEqual(['build the user auth flow']);

    // --- Runtime emits tool_use_start (read) ---
    runtime.emitEvent({
      kind: 'tool_use_start',
      turnId: 't1',
      toolUseId: 'tu-1',
      toolName: 'Read',
      input: { path: 'auth.ts' },
    });

    // --- Runtime requests permission to Write ---
    let resolved: 'allow' | 'deny' | undefined;
    const permReq: PermissionRequest = {
      id: `${session.id}:perm-1`,
      category: 'fs_write',
      toolName: 'Write',
      toolInput: { path: 'auth.ts', content: '...' },
      resolve: (decision) => { resolved = decision as 'allow' | 'deny'; },
    };
    runtime.emitPermission(permReq);
    // IPC + broker flow is synchronous in tests; flush a microtask to let
    // the subscribe callback resolve.
    await Promise.resolve();
    expect(resolved).toBe('allow');
    expect(permissionDecisions).toEqual(['allow']);

    // --- Runtime emits tool_use_result + assistant_text + turn_end ---
    runtime.emitEvent({
      kind: 'tool_use_result',
      toolUseId: 'tu-1',
      output: 'ok',
      durationMs: 20,
      ok: true,
    });
    runtime.emitEvent({
      kind: 'assistant_text',
      turnId: 't1',
      text: 'Auth flow scaffolded.',
      complete: true,
    });
    runtime.emitEvent({
      kind: 'turn_end',
      turnId: 't1',
      durationMs: 40,
      costUsd: 0.0012,
      tokensIn: 250,
      tokensOut: 60,
    });

    // --- Session complete terminator ---
    runtime.emitEvent({
      kind: 'session_complete',
      reason: 'user_done',
      summary: 'Auth flow shipped',
    });

    // Snapshot assertions — each shape expected made it onto the stream.
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('tool_use_start');
    expect(kinds).toContain('tool_use_result');
    expect(kinds).toContain('assistant_text');
    expect(kinds).toContain('turn_end');
    expect(kinds).toContain('session_complete');
    // Permission path — the runtime's `req.resolve` callback was invoked with
    // allow; the broker emitted a `resolved` event that the IM frontend
    // consumes directly (LocalSession doesn't mirror it back onto the session
    // event stream because it's broker-level).
    expect(permissionDecisions).toEqual(['allow']);

    // Cost accumulated.
    expect(session.cost.totalCost).toBeCloseTo(0.0012, 6);
  });
});
