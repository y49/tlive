// src/kernel/contracts/cli-surface.ts
//
// FROZEN SURFACE (v2.0) — DO NOT MODIFY without bumping major version.
// v2.0: replaced 'mcp' with 'hook' (hook-layer pivot).

export type FrozenSubcommand =
  | 'start' | 'stop' | 'restart' | 'status' | 'doctor' | 'daemon-logs'
  | 'workspace'
  | 'setup' | 'install-integrations'
  | 'hook'
  | 'approve'
  | 'version' | 'update';

export const FROZEN_CLI_SUBCOMMANDS: readonly FrozenSubcommand[] = [
  'start', 'stop', 'restart', 'status', 'doctor', 'daemon-logs',
  'workspace',
  'setup', 'install-integrations',
  'hook',
  'approve',
  'version', 'update',
] as const;
