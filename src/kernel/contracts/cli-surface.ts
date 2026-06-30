// src/kernel/contracts/cli-surface.ts
//
// v2 CLI surface. `run` is planned for a future milestone.
export type Subcommand = 'setup' | 'start' | 'stop' | 'status' | 'logs' | 'hook';

export const CLI_SUBCOMMANDS: readonly Subcommand[] = [
  'setup', 'start', 'stop', 'status', 'logs', 'hook',
] as const;
