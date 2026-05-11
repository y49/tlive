// src/kernel/permission/types.ts

export type PermissionSource = 'mcp' | 'sdk';

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: unknown;
  source: PermissionSource;
}
