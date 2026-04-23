// tests/permission/roles.test.ts

import { describe, it, expect } from 'vitest';
import { ROLE_SPECS, roleOf } from '../../src/permission/roles.js';

describe('ROLE_SPECS', () => {
  it('admin can do everything', () => {
    const spec = ROLE_SPECS.admin;
    expect(spec.canSendMessage).toBe(true);
    expect(spec.canResolvePermission).toBe(true);
    expect(spec.canModifyWorkspace).toBe(true);
    for (const cmd of ['help', 'workspace', 'grant', 'revoke', 'mirror', 'foo']) {
      expect(spec.canRunCommand(cmd)).toBe(true);
    }
  });

  it('operator denies workspace + grant + revoke + mirror', () => {
    const spec = ROLE_SPECS.operator;
    expect(spec.canSendMessage).toBe(true);
    expect(spec.canResolvePermission).toBe(true);
    expect(spec.canModifyWorkspace).toBe(false);
    for (const cmd of ['workspace', 'grant', 'revoke', 'mirror']) {
      expect(spec.canRunCommand(cmd)).toBe(false);
    }
    for (const cmd of ['help', 'status', 'sessions', 'search', 'new', 'stop']) {
      expect(spec.canRunCommand(cmd)).toBe(true);
    }
  });

  it('observer is read-only with allowlist', () => {
    const spec = ROLE_SPECS.observer;
    expect(spec.canSendMessage).toBe(false);
    expect(spec.canResolvePermission).toBe(false);
    expect(spec.canModifyWorkspace).toBe(false);
    for (const cmd of ['help', 'status', 'sessions', 'search', 'cost', 'whoami']) {
      expect(spec.canRunCommand(cmd)).toBe(true);
    }
    for (const cmd of ['new', 'stop', 'workspace', 'grant', 'send']) {
      expect(spec.canRunCommand(cmd)).toBe(false);
    }
  });
});

describe('roleOf', () => {
  it('returns per-user role when mapped', () => {
    expect(roleOf({ 'user-1': 'admin' }, 'observer', 'user-1')).toBe('admin');
  });
  it('falls back to defaultRole when user not mapped', () => {
    expect(roleOf({ 'user-1': 'admin' }, 'operator', 'user-2')).toBe('operator');
  });
  it('returns defaultRole when roles map is undefined', () => {
    expect(roleOf(undefined, 'observer', 'u')).toBe('observer');
  });
});
