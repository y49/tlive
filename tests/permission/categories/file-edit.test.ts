// tests/permission/categories/file-edit.test.ts

import { describe, it, expect } from 'vitest';
import { render } from '../../../src/permission/categories/file-edit.js';
import type { PermissionRequest } from '../../../src/runtime/types.js';

function req(
  input: Record<string, unknown>,
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    id: 's:a', category: 'file-edit', toolName: 'Edit', toolInput: input,
    resolve: () => undefined, ...overrides,
  };
}

describe('file-edit category render', () => {
  it('uses runtime-computed diffPreview when present', () => {
    const data = render(req(
      { file_path: '/proj/a.ts', old_string: 'foo', new_string: 'bar' },
      { diffPreview: { from: 'foo', to: 'bar', added: 0, removed: 1, path: '/proj/a.ts' } },
    ));
    expect(data.path).toBe('/proj/a.ts');
    expect(data.from).toBe('foo');
    expect(data.to).toBe('bar');
    expect(data.added).toBe(0);
    expect(data.removed).toBe(1);
  });

  it('computes unified diff from old/new strings', () => {
    const data = render(req({
      file_path: '/a.ts', old_string: 'line1\nline2', new_string: 'LINE1\nline2',
    }));
    expect(data.unifiedDiff).toContain('- line1');
    expect(data.unifiedDiff).toContain('- line2');
    expect(data.unifiedDiff).toContain('+ LINE1');
    expect(data.unifiedDiff).toContain('+ line2');
  });

  it('falls back to input fields when diffPreview is absent', () => {
    const data = render(req({
      path: '/b.ts', old_str: 'x\ny', new_str: 'x\ny\nz',
    }));
    expect(data.path).toBe('/b.ts');
    expect(data.from).toBe('x\ny');
    expect(data.to).toBe('x\ny\nz');
    expect(data.added).toBe(1);
    expect(data.removed).toBe(2);
  });

  it('pure-add path (Write tool with content only)', () => {
    const data = render(req({ file_path: '/new.ts', content: 'hello\nworld' }));
    expect(data.from).toBe('');
    expect(data.to).toBe('hello\nworld');
    expect(data.unifiedDiff).toBe('+ hello\n+ world');
  });

  it('missing input yields empty strings (no crash)', () => {
    const data = render(req({}));
    expect(data.from).toBe('');
    expect(data.to).toBe('');
    expect(data.unifiedDiff).toBe('');
  });
});
