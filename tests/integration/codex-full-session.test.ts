// tests/integration/codex-full-session.test.ts
//
// Same shape as claude-full-session.test.ts but exercising the codex
// provider path. Confirms provider-agnostic SessionManager wiring: the
// factory is selected by provider, the rest of the stack doesn't care.

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
  const home = mkdtempSync(join(tmpdir(), 'tlive-codex-full-'));
  const persistence = new SessionPersistence(join(home, 'sessions'));
  await persistence.init();
  const broker = new PermissionBroker();
  const runtimes: FakeRuntime[] = [];
  const mgr = new SessionManager({
    persistence,
    broker,
    runtimeFactory: (provider) => {
      const r = new FakeRuntime(provider);
      runtimes.push(r);
      return r;
    },
  });
  return { home, mgr, broker, runtimes };
}

describe('integration: codex-full-session', () => {
  let env: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => { env = await boot(); });
  afterEach(async () => {
    await env.mgr.stopAll().catch(() => undefined);
    rmSync(env.home, { recursive: true, force: true });
  });

  it('drives a full Codex turn end-to-end', async () => {
    const events: NotificationEvent[] = [];

    const session = await env.mgr.createLocal({
      workspaceId: 'ws-codex',
      provider: 'codex',
      workdir: env.home,
      source: 'im',
    });
    expect(session.provider).toBe('codex');
    session.onEvent((e) => events.push(e));
    env.broker.subscribe((ev) => {
      if (ev.kind === 'pending') {
        env.broker.resolve(session.id, ev.request.id, 'allow', 'tester');
      }
    });

    const runtime = env.runtimes[0]!;
    expect(runtime.provider).toBe('codex');
    expect(runtime.prepared).toBe(true);

    await session.sendInput('add pagination to the list view', 'im');
    expect(runtime.inputs).toEqual(['add pagination to the list view']);

    runtime.emitEvent({
      kind: 'tool_use_start',
      turnId: 'c1',
      toolUseId: 'c-tu-1',
      toolName: 'ShellExec',
      input: { cmd: 'rg list' },
    });

    let resolved: 'allow' | 'deny' | undefined;
    const permReq: PermissionRequest = {
      id: `${session.id}:perm-c1`,
      category: 'exec',
      toolName: 'ShellExec',
      toolInput: { cmd: 'npm run build' },
      resolve: (d) => { resolved = d as 'allow' | 'deny'; },
    };
    runtime.emitPermission(permReq);
    await Promise.resolve();
    expect(resolved).toBe('allow');

    runtime.emitEvent({
      kind: 'tool_use_result',
      toolUseId: 'c-tu-1',
      output: 'ok',
      durationMs: 15,
      ok: true,
    });
    runtime.emitEvent({
      kind: 'assistant_text',
      turnId: 'c1',
      text: 'Pagination added; tests passing.',
      complete: true,
    });
    runtime.emitEvent({
      kind: 'turn_end',
      turnId: 'c1',
      durationMs: 30,
      costUsd: 0.0008,
      tokensIn: 180,
      tokensOut: 42,
    });
    runtime.emitEvent({
      kind: 'session_complete',
      reason: 'user_done',
      summary: 'Paginated list',
    });

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('tool_use_start');
    expect(kinds).toContain('assistant_text');
    expect(kinds).toContain('turn_end');
    expect(kinds).toContain('session_complete');
    // Permission resolution asserted via the runtime-level `req.resolve`
    // callback above; the broker's `resolved` event is consumed by the IM
    // frontend and not mirrored onto the session event stream.
  });
});
