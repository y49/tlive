// src/permission/roles.ts
//
// Multi-user role spec — who can send messages, resolve permission cards,
// modify workspace config, or invoke IM commands. Actual enforcement lands
// in T7 CommandRouter; this module just exports the RoleSpec table so
// downstream code can look up `ROLE_SPECS[role].canRunCommand(name)`.
//
// Spec: docs/superpowers/specs/2026-04-22-t14b-full-cutover-design.md §5.5.

export type Role = 'admin' | 'operator' | 'observer';

export interface RoleSpec {
  canSendMessage: boolean;
  canResolvePermission: boolean;
  canModifyWorkspace: boolean;
  canRunCommand: (commandName: string) => boolean;
}

// Operator is denied commands that mutate workspace config (the admin-only
// surface). Observer is read-only and gets an explicit allowlist — cheaper
// than a denylist for the narrow read-only set.
const OPERATOR_DENY = new Set(['workspace', 'grant', 'revoke', 'mirror']);
const OBSERVER_ALLOW = new Set(['help', 'status', 'sessions', 'search', 'cost', 'whoami']);

export const ROLE_SPECS: Record<Role, RoleSpec> = {
  admin: {
    canSendMessage: true,
    canResolvePermission: true,
    canModifyWorkspace: true,
    canRunCommand: () => true,
  },
  operator: {
    canSendMessage: true,
    canResolvePermission: true,
    canModifyWorkspace: false,
    canRunCommand: (cmd) => !OPERATOR_DENY.has(cmd),
  },
  observer: {
    canSendMessage: false,
    canResolvePermission: false,
    canModifyWorkspace: false,
    canRunCommand: (cmd) => OBSERVER_ALLOW.has(cmd),
  },
};

/** Convenience — reads a workspace's per-user role map with defaultRole fallback. */
export function roleOf(
  roles: Record<string, Role> | undefined,
  defaultRole: Role,
  userId: string,
): Role {
  return roles?.[userId] ?? defaultRole;
}
