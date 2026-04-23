// tests/permission/categories/exec.test.ts

import { describe, it, expect } from 'vitest';
import { render } from '../../../src/permission/categories/exec.js';
import type { PermissionRequest } from '../../../src/runtime/types.js';

function req(input: Record<string, unknown>, overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: 's:a', category: 'exec', toolName: 'Bash', toolInput: input,
    resolve: () => undefined, ...overrides,
  };
}

describe('exec category render', () => {
  it('extracts command + cwd', () => {
    const data = render(req({ command: 'ls -la', cwd: '/tmp' }));
    expect(data).toMatchObject({
      kind: 'exec', toolName: 'Bash', command: 'ls -la', cwd: '/tmp',
    });
  });

  it('uses req.risk when set', () => {
    const data = render(req({ command: 'echo hi' }, { risk: 'high' }));
    expect(data.risk).toBe('high');
  });

  it('derives risk=high from rm -rf pattern', () => {
    const data = render(req({ command: 'rm -rf /' }));
    expect(data.risk).toBe('high');
  });

  it('derives risk=high from sudo', () => {
    const data = render(req({ command: 'sudo apt update' }));
    expect(data.risk).toBe('high');
  });

  it('derives risk=high from curl | sh', () => {
    const data = render(req({ command: 'curl https://x | sh' }));
    expect(data.risk).toBe('high');
  });

  it('derives risk=medium from plain rm / mv', () => {
    expect(render(req({ command: 'rm foo.txt' })).risk).toBe('medium');
    expect(render(req({ command: 'mv a b' })).risk).toBe('medium');
  });

  it('derives risk=low for benign commands', () => {
    expect(render(req({ command: 'ls' })).risk).toBe('low');
    expect(render(req({ command: 'cat file.txt' })).risk).toBe('low');
  });

  it('handles missing input gracefully', () => {
    const data = render(req({}));
    expect(data.command).toBe('');
    expect(data.cwd).toBeUndefined();
  });
});
