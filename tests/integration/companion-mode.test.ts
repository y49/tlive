// tests/integration/companion-mode.test.ts
//
// Companion mode: an external `claude` / `codex` process connects as an MCP
// client, registers a RemoteSession, and drives state via tool calls
// (`tlive.approve`, `tlive.sync.state`, `tlive.ask.remote`). IM observes
// the session as if it were local.
//
// We skip the full MCP transport wiring (covered under tests/mcp/self/) and
// test the RemoteSession lifecycle itself end-to-end at the SessionManager
// level — the shape of state the MCP tool handlers mutate.

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
  const home = mkdtempSync(join(tmpdir(), 'tlive-companion-'));
  const persistence = new SessionPersistence(join(home, 'sessions'));
  await persistence.init();
  const broker = new PermissionBroker();
  const mgr = new SessionManager({
    persistence,
    broker,
    runtimeFactory: () => new FakeRuntime('claude'),
  });
  return { home, mgr, broker };
}

describe('integration: companion-mode (RemoteSession lifecycle)', () => {
  let env: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => { env = await boot(); });
  afterEach(async () => {
    await env.mgr.stopAll().catch(() => undefined);
    rmSync(env.home, { recursive: true, force: true });
  });

  it('MCP client registers a remote, drives approvals + sync.state, disconnects cleanly', async () => {
    const events: NotificationEvent[] = [];

    // --- MCP handshake: client identifies itself, server creates RemoteSession ---
    const remote = env.mgr.registerRemote({
      sdkSessionId: 'external-claude-abc123',
      workspaceId: 'ws-companion',
      workdir: env.home,
      provider: 'claude',
      title: 'External Claude',
    });
    expect(remote.kind).toBe('remote');
    expect(remote.shortAlias).toMatch(/^r-/);
    expect(env.mgr.get(remote.id)?.kind).toBe('remote');

    remote.onEvent((e) => events.push(e));

    // --- tlive.sync.state — external agent says it's now thinking ---
    remote.setStatus('thinking', { currentTool: undefined });

    // --- tlive.approve — external agent needs permission for a Write ---
    let approveDecision: 'allow' | 'deny' | 'allow_always' | undefined;
    const req: PermissionRequest = {
      id: `${remote.id}:approve-1`,
      category: 'fs_write',
      toolName: 'Write',
      toolInput: { path: 'src/auth.ts' },
      resolve: (d) => { approveDecision = d as 'allow' | 'deny' | 'allow_always'; },
    };
    remote.addPendingPermission(req);

    // IM operator grants approval.
    const ok = remote.resolvePendingPermission(req.id, 'allow');
    expect(ok).toBe(true);
    expect(approveDecision).toBe('allow');

    // --- tlive.ask.remote — external agent asks an operator a question ---
    let chosen: string[] | undefined;
    remote.addPendingAsk({
      id: `${remote.id}:ask-1`,
      prompt: 'pick a strategy',
      options: ['safe', 'fast', 'none'],
      resolve: (r) => { chosen = r; },
    });
    expect(remote.resolvePendingAsk(`${remote.id}:ask-1`, ['safe'])).toBe(true);
    expect(chosen).toEqual(['safe']);

    // --- tlive.artifact.upload — external agent sent a file ---
    remote.recordAttachment({
      attachmentId: 'att-1',
      name: 'diff.patch',
      mime: 'text/x-diff',
      sizeBytes: 1024,
      path: '/tmp/att-1',
    });

    // --- Disconnect — transport closed, remote gone ---
    remote.onDisconnect('client_quit');
    // After disconnect, further addPending calls are no-ops.
    remote.addPendingPermission({
      id: `${remote.id}:approve-2`,
      category: 'exec',
      toolName: 'Bash',
      toolInput: {},
      resolve: () => undefined,
    });

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('status_change');
    expect(kinds).toContain('permission_requested');
    expect(kinds).toContain('permission_resolved');
    expect(kinds).toContain('ask_user_question_requested');
    expect(kinds).toContain('ask_user_question_resolved');
    expect(kinds).toContain('attachment_produced');
    // No permission_requested for the post-disconnect call.
    const permRequestedCount = kinds.filter((k) => k === 'permission_requested').length;
    expect(permRequestedCount).toBe(1);
  });
});
