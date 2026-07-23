// src/kernel/contracts/cli-surface.ts
//
// v2 CLI surface.
export type Subcommand = 'setup' | 'start' | 'stop' | 'status' | 'logs' | 'run' | 'url' | 'hook' | 'mode' | 'mute' | 'trust' | 'safe' | 'desktop';

export const CLI_SUBCOMMANDS: readonly Subcommand[] = [
  'setup', 'start', 'stop', 'status', 'logs', 'run', 'url', 'hook',
  'mode', 'mute', 'trust', 'safe', 'desktop',
] as const;
