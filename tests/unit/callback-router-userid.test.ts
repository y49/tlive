import { describe, it, expect } from 'vitest';
import { userRole } from '../../src/im/commands/_shared.js';

describe('userRole', () => {
  const ws = { id: 'w', roles: { 'u-1': 'admin' }, defaultRole: 'observer' } as never;

  it('returns explicit role when userId is in workspace.roles', () => {
    expect(userRole(ws, 'u-1')).toBe('admin');
  });
  it('returns defaultRole when userId is not mapped', () => {
    expect(userRole(ws, 'u-999')).toBe('observer');
  });
  it('returns defaultRole when userId is null', () => {
    expect(userRole(ws, null)).toBe('observer');
  });
  it('returns observer when defaultRole is also missing', () => {
    expect(userRole({ id: 'w', roles: {} } as never, null)).toBe('observer');
  });
});
