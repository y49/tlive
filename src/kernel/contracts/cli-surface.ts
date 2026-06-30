// src/kernel/contracts/cli-surface.ts
//
// v2 CLI surface.
export type Subcommand = 'setup' | 'start' | 'stop' | 'status' | 'logs' | 'run' | 'hook';

export const CLI_SUBCOMMANDS: readonly Subcommand[] = [
  'setup', 'start', 'stop', 'status', 'logs', 'run', 'hook',
] as const;
