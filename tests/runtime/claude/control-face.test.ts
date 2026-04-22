// tests/runtime/claude/control-face.test.ts
//
// Unit test of the Claude control-face wrapper. Validates that (a) it throws
// UnsupportedByRuntimeError if called before start, (b) it forwards plain
// operations to the underlying Query, (c) applyPermissionRules wraps rules in
// the correct Settings shape.

import { describe, it, expect } from 'vitest';
import { makeClaudeControlFace } from '../../../src/runtime/claude/control.js';
import { UnsupportedByRuntimeError } from '../../../src/runtime/abstractions.js';

describe('claude control face', () => {
  it('throws UnsupportedByRuntimeError when queryIter is null', async () => {
    const ctrl = makeClaudeControlFace(() => null, () => null);
    await expect(ctrl.interrupt()).rejects.toThrow(UnsupportedByRuntimeError);
  });

  it('forwards setModel to query.setModel', async () => {
    const calls: unknown[] = [];
    const fakeQuery = { setModel: (m: string | undefined) => { calls.push(m); return Promise.resolve(); } };
    const ctrl = makeClaudeControlFace(() => fakeQuery as never, () => null);
    await ctrl.setModel('claude-opus-4-6');
    expect(calls).toEqual(['claude-opus-4-6']);
  });

  it('applyPermissionRules wraps rules in permissions via applyFlagSettings', async () => {
    const calls: unknown[] = [];
    const fakeQuery = { applyFlagSettings: (s: unknown) => { calls.push(s); return Promise.resolve(); } };
    const ctrl = makeClaudeControlFace(() => fakeQuery as never, () => null);
    await ctrl.applyPermissionRules({ allow: ['Bash(npm *)'] });
    expect(calls).toEqual([{ permissions: { allow: ['Bash(npm *)'] } }]);
  });
});
