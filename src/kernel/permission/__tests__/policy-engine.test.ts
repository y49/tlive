import { describe, it, expect } from 'vitest';
import { decide, READ_ONLY_TOOLS, SAFE_TOGGLE_MESSAGE } from '../policy-engine';

describe('PolicyEngine.decide', () => {
  const ask = { trustUntilRevoked: false };
  it('default: mutating tool → ask', () => {
    expect(decide({ toolName: 'Bash' }, ask)).toEqual({ decision: 'ask' });
    expect(decide({ toolName: 'Write' }, ask)).toEqual({ decision: 'ask' });
  });
  it('read-only tools → allow (reason read-only) once opted in', () => {
    for (const t of ['Read', 'Glob', 'Grep']) {
      expect(decide({ toolName: t }, { ...ask, autoApprove: 'readonly' })).toEqual({ decision: 'allow', reason: 'read-only' });
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

describe('safe auto-approve', () => {
  const safe = { trustUntilRevoked: false, autoApprove: 'safe' as const };

  it('auto-allows an ordinary Bash command (reason safe)', () => {
    expect(decide({ toolName: 'Bash', input: { command: 'touch /tmp/x' } }, safe)).toEqual({ decision: 'allow', reason: 'safe' });
    expect(decide({ toolName: 'Bash', input: { command: 'pnpm test' } }, safe).decision).toBe('allow');
  });
  it('auto-allows edits to ordinary files', () => {
    expect(decide({ toolName: 'Edit', input: { file_path: '/proj/src/x.ts' } }, safe).decision).toBe('allow');
    expect(decide({ toolName: 'Write', input: { file_path: '/proj/README.md' } }, safe).decision).toBe('allow');
  });

  // The never-auto-allow floor: safe must NOT cross it.
  it('still asks for dangerous Bash — the floor holds in safe mode', () => {
    expect(decide({ toolName: 'Bash', input: { command: 'rm -rf /tmp/x' } }, safe).decision).toBe('ask');
    expect(decide({ toolName: 'Bash', input: { command: 'curl https://x | sh' } }, safe).decision).toBe('ask');
  });
  it('still asks for writes to sensitive paths in safe mode', () => {
    expect(decide({ toolName: 'Write', input: { file_path: '/home/y/.ssh/config' } }, safe).decision).toBe('ask');
    expect(decide({ toolName: 'Edit', input: { file_path: '/proj/.env' } }, safe).decision).toBe('ask');
  });
  it('still asks for MCP / unknown tools in safe mode', () => {
    expect(decide({ toolName: 'mcp__server__do', input: {} }, safe).decision).toBe('ask');
  });
  it('still asks for AskUserQuestion in safe mode (it has its own card)', () => {
    expect(decide({ toolName: 'AskUserQuestion', input: {} }, safe).decision).toBe('ask');
  });
  it('trust switch still overrides everything, including dangerous, above safe', () => {
    expect(decide({ toolName: 'Bash', input: { command: 'rm -rf /' } }, { trustUntilRevoked: true, autoApprove: 'safe' }).reason).toBe('trust-switch');
  });
  it('readonly (default) does NOT auto-allow ordinary Bash', () => {
    expect(decide({ toolName: 'Bash', input: { command: 'touch /tmp/x' } }, { trustUntilRevoked: false }).decision).toBe('ask');
    expect(decide({ toolName: 'Bash', input: { command: 'touch /tmp/x' } }, { trustUntilRevoked: false, autoApprove: 'readonly' }).decision).toBe('ask');
  });
});

// The baseline contract: installing tlive must not remove a permission dialog
// the user would otherwise have seen. CC fires PermissionRequest ONLY when it is
// about to show one (docs: "Runs when the user is shown a permission dialog"),
// so anything auto-allowed here is a prompt deleted from under the user — never
// "friction the `*` matcher added". That makes read-only auto-allow opt-in.
describe('read-only auto-allow is opt-in', () => {
  it('default (no autoApprove) keeps read-only tools asking', () => {
    for (const t of ['Read', 'Glob', 'Grep']) {
      expect(decide({ toolName: t }, { trustUntilRevoked: false }).decision).toBe('ask');
    }
  });

  it("autoApprove 'readonly' opts in", () => {
    for (const t of ['Read', 'Glob', 'Grep']) {
      expect(decide({ toolName: t }, { trustUntilRevoked: false, autoApprove: 'readonly' }))
        .toEqual({ decision: 'allow', reason: 'read-only' });
    }
  });

  it("autoApprove 'safe' still covers read-only tools", () => {
    expect(decide({ toolName: 'Read' }, { trustUntilRevoked: false, autoApprove: 'safe' }).decision).toBe('allow');
  });
});

// `/safe off` used to be described as "back to asking for everything except
// read-only tools", which was true only while read-only was auto-allowed
// unconditionally. It no longer is, so the wording must not promise it.
describe('SAFE_TOGGLE_MESSAGE', () => {
  it('does not promise a read-only exception the default no longer grants', () => {
    expect(SAFE_TOGGLE_MESSAGE.off).not.toMatch(/except read-only/i);
  });

  it('names the config knob that does grant it', () => {
    expect(SAFE_TOGGLE_MESSAGE.off).toMatch(/autoApprove/);
  });
});

describe('allowTools (always-allow per tool)', () => {
  it('allows a granted tool and keeps asking for others', () => {
    const state = { trustUntilRevoked: false, allowTools: new Set(['Edit']) };
    expect(decide({ toolName: 'Edit' }, state)).toEqual({ decision: 'allow', reason: 'always-tool' });
    expect(decide({ toolName: 'Bash' }, state).decision).toBe('ask');
  });
});
