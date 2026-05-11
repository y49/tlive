// src/kernel/contracts/cli-surface.ts
//
// FROZEN SURFACE — DO NOT MODIFY without bumping major version.
//
// Adding a subcommand = adding a new metadata operation = should open a
// new spec for discussion.

export type FrozenSubcommand =
  | 'start' | 'stop' | 'restart' | 'status' | 'doctor' | 'daemon-logs'
  | 'handoff'
  | 'workspace'
  | 'setup' | 'install-integrations'
  | 'mcp'
  | 'approve'
  | 'version' | 'update';

export const FROZEN_CLI_SUBCOMMANDS: readonly FrozenSubcommand[] = [
  'start', 'stop', 'restart', 'status', 'doctor', 'daemon-logs',
  'handoff',
  'workspace',
  'setup', 'install-integrations',
  'mcp',
  'approve',
  'version', 'update',
] as const;
