import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { CodexApprovalBridge } from '../approval-bridge.js';
import { CodexEventAdapter } from '../event-adapter.js';

type PermissionDecision = 'allow' | 'deny' | 'allow_always';
type PermissionFn = (
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
) => Promise<PermissionDecision>;

function makeClient() {
  const handlers = new Map<string, (p: unknown) => Promise<unknown>>();
  return {
    onCommandExecutionApproval: (h: any) => handlers.set('cmdExec', h),
    onFileChangeApproval: (h: any) => handlers.set('fileChange', h),
    onPermissionsApproval: (h: any) => handlers.set('permissions', h),
    onMcpElicitation: (h: any) => handlers.set('mcp', h),
    _handlers: handlers,
  };
}

describe('CodexApprovalBridge', () => {
  let client: ReturnType<typeof makeClient>;
  let eventAdapter: CodexEventAdapter;
  let onPermissionRequest: Mock<PermissionFn>;

  beforeEach(() => {
    client = makeClient();
    eventAdapter = new CodexEventAdapter();
    onPermissionRequest = vi.fn();
  });

  function wire(handler: PermissionFn | undefined) {
    const bridge = new CodexApprovalBridge(client as any, eventAdapter, handler);
    bridge.wireHandlers();
    return bridge;
  }

  it('commandExecution allow → accept', async () => {
    onPermissionRequest.mockResolvedValue('allow');
    wire(onPermissionRequest);
    const res = await client._handlers.get('cmdExec')!({
      threadId: 't', turnId: 'tr', itemId: 'i', command: 'ls', cwd: '/tmp',
    });
    expect(res).toEqual({ decision: 'accept' });
    expect(onPermissionRequest).toHaveBeenCalledWith(
      'Bash',
      { command: 'ls', cwd: '/tmp' },
      expect.any(String),
    );
  });

  it('commandExecution allow_always → acceptForSession', async () => {
    onPermissionRequest.mockResolvedValue('allow_always');
    wire(onPermissionRequest);
    const res = await client._handlers.get('cmdExec')!({ itemId: 'i', command: 'ls' });
    expect(res).toEqual({ decision: 'acceptForSession' });
  });

  it('commandExecution deny → decline', async () => {
    onPermissionRequest.mockResolvedValue('deny');
    wire(onPermissionRequest);
    const res = await client._handlers.get('cmdExec')!({ itemId: 'i', command: 'rm -rf /' });
    expect(res).toEqual({ decision: 'decline' });
  });

  it('fileChange allow → accept (with changes from eventAdapter cache)', async () => {
    onPermissionRequest.mockResolvedValue('allow');
    eventAdapter.handle('thread/started', { thread: { id: 't' } });
    eventAdapter.handle('item/started', {
      item: { id: 'fc1', type: 'fileChange', changes: [{ path: '/x', kind: 'update' }], status: 'completed' },
    });
    wire(onPermissionRequest);
    const res = await client._handlers.get('fileChange')!({
      threadId: 't', turnId: 'tr', itemId: 'fc1',
    });
    expect(res).toEqual({ decision: 'accept' });
    expect(onPermissionRequest).toHaveBeenCalledWith(
      'Edit',
      { changes: [{ path: '/x', kind: 'update' }] },
      expect.any(String),
    );
  });

  it('fileChange cache miss → broker called with empty changes', async () => {
    onPermissionRequest.mockResolvedValue('allow');
    wire(onPermissionRequest);
    await client._handlers.get('fileChange')!({ itemId: 'missing' });
    expect(onPermissionRequest).toHaveBeenCalledWith(
      'Edit',
      { changes: [] },
      expect.any(String),
    );
  });

  it('permissions approval allow → accept with turn scope', async () => {
    onPermissionRequest.mockResolvedValue('allow');
    wire(onPermissionRequest);
    const res = await client._handlers.get('permissions')!({
      threadId: 't', turnId: 'tr', itemId: 'i',
      permissions: { fileSystem: { writeRoots: ['/x'] } },
    });
    expect(res).toMatchObject({ scope: 'turn' });
  });

  it('permissions allow_always → scope session', async () => {
    onPermissionRequest.mockResolvedValue('allow_always');
    wire(onPermissionRequest);
    const res = await client._handlers.get('permissions')!({
      permissions: { network: { hosts: ['example.com'] } },
    });
    expect(res).toMatchObject({ scope: 'session' });
  });

  it('permissions deny → empty permissions granted', async () => {
    onPermissionRequest.mockResolvedValue('deny');
    wire(onPermissionRequest);
    const res = await client._handlers.get('permissions')!({
      permissions: { fileSystem: { writeRoots: ['/x'] } },
    });
    expect(res).toMatchObject({ permissions: {}, scope: 'turn' });
  });

  it('MCP elicitation → auto-decline with null content, warn logged', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    wire(onPermissionRequest);
    const res = await client._handlers.get('mcp')!({ threadId: 't', serverName: 'x' });
    expect(res).toEqual({ action: 'decline', content: null });
    expect(warnSpy).toHaveBeenCalled();
    expect(onPermissionRequest).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('without onPermissionRequest (perm off) commandExecution auto-accepts', async () => {
    wire(undefined);
    const res = await client._handlers.get('cmdExec')!({ itemId: 'i', command: 'ls' });
    expect(res).toEqual({ decision: 'accept' });
  });

  it('onPermissionRequest throws → decline sent back with warn', async () => {
    onPermissionRequest.mockRejectedValue(new Error('broker dead'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    wire(onPermissionRequest);
    const res = await client._handlers.get('cmdExec')!({ itemId: 'i', command: 'ls' });
    expect(res).toEqual({ decision: 'decline' });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
