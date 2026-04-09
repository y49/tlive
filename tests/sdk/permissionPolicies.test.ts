// tests/sdk/permissionPolicies.test.ts
import { describe, it, expect } from 'vitest';
import { isAllowed } from '../../src/sdk/permissionPolicies.js';

describe('permissionPolicies', () => {
  it('default allows only safe tools', () => {
    expect(isAllowed('default', 'Read', {})).toBe(true);
    expect(isAllowed('default', 'Grep', {})).toBe(true);
    expect(isAllowed('default', 'Bash', {})).toBe(false);
    expect(isAllowed('default', 'Edit', {})).toBe(false);
  });

  it('accept-edits allows edit tools', () => {
    expect(isAllowed('accept-edits', 'Edit', {})).toBe(true);
    expect(isAllowed('accept-edits', 'Write', {})).toBe(true);
    expect(isAllowed('accept-edits', 'Read', {})).toBe(true);
    expect(isAllowed('accept-edits', 'Bash', {})).toBe(false);
  });

  it('auto-approve allows Bash except dangerous', () => {
    expect(isAllowed('auto-approve', 'Bash', { command: 'npm test' })).toBe(true);
    expect(isAllowed('auto-approve', 'Bash', { command: 'rm -rf /' })).toBe(false);
    expect(isAllowed('auto-approve', 'Bash', { command: 'git push --force' })).toBe(false);
    expect(isAllowed('auto-approve', 'Edit', {})).toBe(true);
  });

  it('yolo allows everything', () => {
    expect(isAllowed('yolo', 'Bash', { command: 'rm -rf /' })).toBe(true);
    expect(isAllowed('yolo', 'Agent', {})).toBe(true);
  });
});
