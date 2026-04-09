import { describe, it, expect, vi } from 'vitest';
import { ClaudePermissionHandler, matchesToolPermission } from '../../src/sdk/permissionHandler.js';

describe('ClaudePermissionHandler', () => {
  it('emits permission request and resolves on allow', async () => {
    const requests: Array<{ id: string; tool: string }> = [];
    const handler = new ClaudePermissionHandler({
      onPermissionRequest: (id, tool) => requests.push({ id, tool }),
    });
    const promise = handler.handleToolCall('Bash', { command: 'ls' });
    expect(requests).toHaveLength(1);
    handler.resolve(requests[0].id, 'allow');
    const result = await promise;
    expect(result.behavior).toBe('allow');
  });

  it('denies on timeout', async () => {
    const handler = new ClaudePermissionHandler({ timeout: 50 });
    const result = await handler.handleToolCall('Bash', { command: 'rm' });
    expect(result.behavior).toBe('deny');
    expect(result.message).toBe('Permission timeout');
  });

  it('AskUserQuestion has no timeout', async () => {
    const requests: string[] = [];
    const handler = new ClaudePermissionHandler({
      timeout: 50,
      onPermissionRequest: (id) => requests.push(id),
    });
    const promise = handler.handleToolCall('AskUserQuestion', { question: 'hi' });
    await new Promise((r) => setTimeout(r, 100));
    expect(handler.pendingCount).toBe(1);
    handler.resolve(requests[0], 'allow');
    const result = await promise;
    expect(result.behavior).toBe('allow');
  });

  it('allow_always skips future requests for same tool', async () => {
    const requests: string[] = [];
    const handler = new ClaudePermissionHandler({
      onPermissionRequest: (id) => requests.push(id),
    });
    const p1 = handler.handleToolCall('Bash', { command: 'echo a' });
    handler.resolve(requests[0], 'allow_always');
    await p1;
    const result = await handler.handleToolCall('Bash', { command: 'echo b' });
    expect(result.behavior).toBe('allow');
    expect(requests).toHaveLength(1);
  });

  it('cancelAll denies all pending', async () => {
    const requests: string[] = [];
    const handler = new ClaudePermissionHandler({
      onPermissionRequest: (id) => requests.push(id),
    });
    const p1 = handler.handleToolCall('Bash', { command: 'a' });
    const p2 = handler.handleToolCall('Bash', { command: 'b' });
    handler.cancelAll();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.behavior).toBe('deny');
    expect(r2.behavior).toBe('deny');
  });

  it('denies on abort signal', async () => {
    const controller = new AbortController();
    const handler = new ClaudePermissionHandler({
      onPermissionRequest: () => {},
    });
    const promise = handler.handleToolCall('Bash', {}, { signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(result.behavior).toBe('deny');
    expect(result.message).toBe('Aborted');
  });
});

describe('matchesToolPermission', () => {
  it('matches exact name', () => {
    expect(matchesToolPermission('Bash', 'Bash')).toBe(true);
    expect(matchesToolPermission('Bash', 'Read')).toBe(false);
  });
  it('matches prefix pattern', () => {
    expect(matchesToolPermission('Bash', 'Bash(prefix:npm)')).toBe(true);
  });
});
