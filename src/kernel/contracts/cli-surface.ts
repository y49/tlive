// src/kernel/contracts/cli-surface.ts
//
// CLI subcommand surface (v2.1). `run` is added in M2.
export type Subcommand = 'setup' | 'start' | 'stop' | 'status' | 'logs' | 'hook';

export const CLI_SUBCOMMANDS: readonly Subcommand[] = [
  'setup', 'start', 'stop', 'status', 'logs', 'hook',
] as const;
