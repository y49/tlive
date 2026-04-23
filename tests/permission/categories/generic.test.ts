// tests/permission/categories/generic.test.ts

import { describe, it, expect } from 'vitest';
import { render } from '../../../src/permission/categories/generic.js';
import type { PermissionRequest } from '../../../src/runtime/types.js';

function req(toolName: string, toolInput: unknown): PermissionRequest {
  return {
    id: 's:a',
    category: 'generic',
    toolName,
    toolInput,
    resolve: () => undefined,
  };
}

describe('generic category render', () => {
  it('renders toolName + pretty-printed JSON input', () => {
    const data = render(req('MyCustomTool', { foo: 'bar', n: 1 }));
    expect(data.kind).toBe('generic');
    expect(data.toolName).toBe('MyCustomTool');
    expect(data.inputJson).toBe(JSON.stringify({ foo: 'bar', n: 1 }, null, 2));
  });

  it('handles empty / null input', () => {
    expect(render(req('T', {})).inputJson).toBe('{}');
    expect(render(req('T', null)).inputJson).toBe('null');
  });

  it('falls back to placeholder for unserializable input (circular ref)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const data = render(req('Circ', circular));
    expect(data.kind).toBe('generic');
    expect(data.inputJson).toBe('[unserializable]');
  });
});
