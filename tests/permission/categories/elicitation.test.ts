// tests/permission/categories/elicitation.test.ts

import { describe, it, expect } from 'vitest';
import { render } from '../../../src/permission/categories/elicitation.js';
import type { ElicitationRequest } from '../../../src/runtime/types.js';

function req(overrides: Partial<ElicitationRequest>): ElicitationRequest {
  return {
    id: 'el-1',
    mcpServerName: 'mcp-test',
    mode: 'confirm',
    description: 'do the thing?',
    resolve: () => undefined,
    ...overrides,
  };
}

describe('elicitation category render', () => {
  it('form mode passes schema through as fields', () => {
    const schema = { name: { type: 'string', required: true } };
    const data = render(req({ mode: 'form', schema, description: 'pick a name' }));
    expect(data).toMatchObject({
      kind: 'elicitation',
      mode: 'form',
      mcpServerName: 'mcp-test',
      description: 'pick a name',
      fields: schema,
    });
    expect(data.url).toBeUndefined();
  });

  it('confirm mode carries description and no fields/url', () => {
    const data = render(req({ mode: 'confirm', description: 'proceed?' }));
    expect(data).toMatchObject({
      kind: 'elicitation',
      mode: 'confirm',
      description: 'proceed?',
    });
    expect(data.fields).toBeUndefined();
    expect(data.url).toBeUndefined();
  });

  it('url-auth mode passes url through', () => {
    const data = render(req({ mode: 'url-auth', url: 'https://auth.example/login' }));
    expect(data).toMatchObject({
      kind: 'elicitation',
      mode: 'url-auth',
      url: 'https://auth.example/login',
    });
    expect(data.fields).toBeUndefined();
  });

  it('copies requestId from source request', () => {
    const data = render(req({ id: 'abc-123' }));
    expect(data.requestId).toBe('abc-123');
  });
});
