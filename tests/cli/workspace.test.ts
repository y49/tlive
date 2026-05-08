// tests/cli/workspace.test.ts — `tlive workspace` CLI surface.
//
// We use the dependency-injection seam exposed on `workspaceCommand`
// (request / ensureRunning / readLine) instead of vi.mock so the tests stay
// transparent and don't depend on hoisted-mock semantics.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { workspaceCommand, type WorkspaceCommandDeps } from '../../src/cli/workspace.js';
import type { IpcRequest, IpcResponse } from '../../src/ipc/protocol.js';

interface Captured {
  reqs: IpcRequest[];
  out: string[];
  err: string[];
  exitCodes: number[];
}

function makeHarness(responder: (req: IpcRequest) => IpcResponse): {
  deps: WorkspaceCommandDeps;
  cap: Captured;
  restore: () => void;
} {
  const cap: Captured = { reqs: [], out: [], err: [], exitCodes: [] };
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const origExit = process.exit;

  process.stdout.write = ((s: string | Uint8Array) => {
    cap.out.push(typeof s === 'string' ? s : s.toString());
    return true;
  }) as never;
  process.stderr.write = ((s: string | Uint8Array) => {
    cap.err.push(typeof s === 'string' ? s : s.toString());
    return true;
  }) as never;
  process.exit = ((code?: number) => {
    cap.exitCodes.push(code ?? 0);
    // Throw to short-circuit the calling code (mirrors real exit semantics
    // for the test). Each test catches/awaits accordingly.
    throw new Error(`__exit__:${code ?? 0}`);
  }) as never;

  const deps: WorkspaceCommandDeps = {
    ensureRunning: async () => undefined,
    request: async (req) => {
      cap.reqs.push(req);
      return responder(req);
    },
    readLine: async () => 'y',
  };

  const restore = () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exit = origExit;
  };

  return { deps, cap, restore };
}

async function runSafely(fn: () => Promise<void>): Promise<void> {
  try { await fn(); }
  catch (e) {
    if ((e as Error).message?.startsWith('__exit__:')) return;
    throw e;
  }
}

describe('tlive workspace CLI', () => {
  let harness: ReturnType<typeof makeHarness>;

  afterEach(() => { harness?.restore(); });

  it('list: prints empty message when no workspaces', async () => {
    harness = makeHarness(() => ({ kind: 'workspace.list', workspaces: [] }));
    await runSafely(() => workspaceCommand(['list'], harness.deps));
    const joined = harness.cap.out.join('');
    expect(joined).toMatch(/No workspaces/);
    expect(harness.cap.reqs).toEqual([{ kind: 'workspace.list' }]);
  });

  it('list: prints rows when workspaces exist', async () => {
    harness = makeHarness(() => ({
      kind: 'workspace.list',
      workspaces: [
        { id: 'w1', name: 'foo', workdir: '/p/f', chatInstances: 2, activeSessionId: null },
        { id: 'w2', name: 'bar', workdir: '/p/b', chatInstances: 0, activeSessionId: null },
      ],
    }));
    await runSafely(() => workspaceCommand(['list'], harness.deps));
    const joined = harness.cap.out.join('');
    expect(joined).toMatch(/NAME/);
    expect(joined).toMatch(/CHATS/);
    expect(joined).toMatch(/foo/);
    expect(joined).toMatch(/bar/);
    expect(joined).not.toMatch(/ADMIN/);
  });

  it('add: posts workspace.add IPC with cwd default + basename name', async () => {
    harness = makeHarness(() => ({ kind: 'workspace.added', workspaceId: 'new-id-1234567890' }));
    await runSafely(() => workspaceCommand(['add'], harness.deps));
    expect(harness.cap.reqs).toHaveLength(1);
    const req = harness.cap.reqs[0]!;
    expect(req.kind).toBe('workspace.add');
    if (req.kind === 'workspace.add') {
      expect(req.workspace.workdir).toBe(process.cwd());
      expect(typeof req.workspace.name).toBe('string');
      expect(req.workspace.name.length).toBeGreaterThan(0);
    }
    expect(harness.cap.out.join('')).toMatch(/Created workspace/);
  });

  it('add: --name flag propagates', async () => {
    harness = makeHarness(() => ({ kind: 'workspace.added', workspaceId: 'wid-deadbeef' }));
    await runSafely(() => workspaceCommand(
      ['add', '/tmp/proj', '--name', 'myproj'],
      harness.deps,
    ));
    const req = harness.cap.reqs[0]!;
    expect(req.kind).toBe('workspace.add');
    if (req.kind === 'workspace.add') {
      expect(req.workspace.name).toBe('myproj');
      expect(req.workspace.workdir).toBe('/tmp/proj');
    }
  });

  it('remove with -y skips confirmation prompt', async () => {
    harness = makeHarness(() => ({ kind: 'workspace.removed', ok: true }));
    // Override readLine to throw if called — proves we never prompted.
    harness.deps.readLine = async () => { throw new Error('readLine should not be called'); };
    await runSafely(() => workspaceCommand(['remove', 'foo', '-y'], harness.deps));
    expect(harness.cap.reqs).toEqual([{ kind: 'workspace.remove', idOrName: 'foo', force: false }]);
    expect(harness.cap.out.join('')).toMatch(/Removed/);
  });

  it('remove with --force passes force flag in IPC request', async () => {
    harness = makeHarness(() => ({ kind: 'workspace.removed', ok: true }));
    harness.deps.readLine = async () => { throw new Error('readLine should not be called'); };
    await runSafely(() => workspaceCommand(['remove', 'bar', '-y', '--force'], harness.deps));
    expect(harness.cap.reqs).toEqual([{ kind: 'workspace.remove', idOrName: 'bar', force: true }]);
    expect(harness.cap.out.join('')).toMatch(/Removed/);
  });

  it('remove without -y prompts and aborts on n', async () => {
    harness = makeHarness(() => ({ kind: 'workspace.removed', ok: true }));
    harness.deps.readLine = async () => 'n';
    await runSafely(() => workspaceCommand(['remove', 'foo'], harness.deps));
    expect(harness.cap.reqs).toEqual([]); // no IPC issued
    expect(harness.cap.out.join('')).toMatch(/Aborted/);
  });

  it('remove: shows daemon-supplied reason on failure', async () => {
    harness = makeHarness(() => ({ kind: 'workspace.removed', ok: false, reason: 'not found: bogus' }));
    await runSafely(() => workspaceCommand(['remove', 'bogus', '-y'], harness.deps));
    expect(harness.cap.err.join('')).toMatch(/not found: bogus/);
    expect(harness.cap.exitCodes).toContain(1);
  });

  it('unknown subcommand exits 2', async () => {
    harness = makeHarness(() => ({ kind: 'error', message: 'unreachable' }));
    await runSafely(() => workspaceCommand(['frobnicate'], harness.deps));
    expect(harness.cap.exitCodes).toContain(2);
    expect(harness.cap.err.join('')).toMatch(/unknown subcommand/);
  });

  it('no args / --help prints usage to stderr without exit', async () => {
    harness = makeHarness(() => ({ kind: 'error', message: 'unreachable' }));
    await runSafely(() => workspaceCommand([], harness.deps));
    expect(harness.cap.err.join('')).toMatch(/Usage:/);
    expect(harness.cap.reqs).toEqual([]);
  });
});
