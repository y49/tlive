import { describe, it, expect } from 'vitest';
import { CodexApprovalBridge } from '../../../src/runtime/codex-app-server/approval-bridge.js';
import type { PermissionRequest } from '../../../src/runtime/types.js';

describe('CodexApprovalBridge', () => {
  it('emits PermissionRequest for exec approval, maps allow → approved', async () => {
    const emitted: PermissionRequest[] = [];
    const bridge = new CodexApprovalBridge({ sessionId: 's', emit: (r) => emitted.push(r) });
    const p = bridge.handleCommandExecutionApproval('tu1', ['ls'], '/x');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toBe('s:tu1');
    expect(emitted[0].toolName).toBe('Bash');
    expect(emitted[0].toolInput).toEqual({ command: ['ls'], cwd: '/x' });
    emitted[0].resolve('allow');
    await expect(p).resolves.toBe('approved');
  });

  it('maps allow_always → approved_for_session (file change)', async () => {
    const emitted: PermissionRequest[] = [];
    const bridge = new CodexApprovalBridge({ sessionId: 's', emit: (r) => emitted.push(r) });
    const p = bridge.handleFileChangeApproval('tu2', '/f.ts', [{ kind: 'update' }]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toBe('s:tu2');
    expect(emitted[0].toolName).toBe('Edit');
    emitted[0].resolve('allow_always');
    await expect(p).resolves.toBe('approved_for_session');
  });

  it('maps deny → denied', async () => {
    const emitted: PermissionRequest[] = [];
    const bridge = new CodexApprovalBridge({ sessionId: 's', emit: (r) => emitted.push(r) });
    const p = bridge.handleCommandExecutionApproval('tu', ['rm', '-rf', '/'], '/x');
    expect(emitted).toHaveLength(1);
    emitted[0].resolve('deny');
    await expect(p).resolves.toBe('denied');
  });

  it('waits for resolve before settling', async () => {
    const emitted: PermissionRequest[] = [];
    const bridge = new CodexApprovalBridge({ sessionId: 's', emit: (r) => emitted.push(r) });
    const p = bridge.handleCommandExecutionApproval('tu', ['echo', 'hi'], '/x');
    let settled = false;
    void p.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    emitted[0].resolve('allow');
    await p;
    expect(settled).toBe(true);
  });
});
