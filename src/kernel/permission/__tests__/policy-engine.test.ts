import { describe, it, expect } from 'vitest';
import { decide, READ_ONLY_TOOLS } from '../policy-engine';

describe('PolicyEngine.decide', () => {
  const ask = { trustUntilRevoked: false };
  it('default: mutating tool → ask', () => {
    expect(decide({ toolName: 'Bash' }, ask)).toEqual({ decision: 'ask' });
    expect(decide({ toolName: 'Write' }, ask)).toEqual({ decision: 'ask' });
  });
  it('read-only tools → allow (reason read-only)', () => {
    for (const t of ['Read', 'Glob', 'Grep']) {
      expect(decide({ toolName: t }, ask)).toEqual({ decision: 'allow', reason: 'read-only' });
    }
  });
  it('WebFetch/WebSearch are NOT read-only → ask', () => {
    expect(decide({ toolName: 'WebFetch' }, ask).decision).toBe('ask');
    expect(decide({ toolName: 'WebSearch' }, ask).decision).toBe('ask');
  });
  it('trust switch on → allow everything (reason trust-switch), overrides mutating', () => {
    expect(decide({ toolName: 'Bash' }, { trustUntilRevoked: true })).toEqual({ decision: 'allow', reason: 'trust-switch' });
  });
  it('unknown/MCP tool defaults to ask (fail-safe)', () => {
    expect(decide({ toolName: 'mcp__x__do' }, ask).decision).toBe('ask');
  });
  it('READ_ONLY_TOOLS is exactly Read/Glob/Grep', () => {
    expect([...READ_ONLY_TOOLS].sort()).toEqual(['Glob', 'Grep', 'Read']);
  });
  it('AskUserQuestion is not read-only → ask (it has its own remote card now)', () => {
    expect(decide({ toolName: 'AskUserQuestion' }, ask).decision).toBe('ask');
  });
});

describe('allowTools (always-allow per tool)', () => {
  it('allows a granted tool and keeps asking for others', () => {
    const state = { trustUntilRevoked: false, allowTools: new Set(['Edit']) };
    expect(decide({ toolName: 'Edit' }, state)).toEqual({ decision: 'allow', reason: 'always-tool' });
    expect(decide({ toolName: 'Bash' }, state).decision).toBe('ask');
  });
});
