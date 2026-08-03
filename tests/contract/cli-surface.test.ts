import { describe, it, expect } from 'vitest';
import { CLI_SUBCOMMANDS } from '../../src/kernel/contracts/cli-surface.js';
describe('v2 CLI surface', () => {
  it('is exactly the 8 core subcommands + `mode` (posture: off/notify/full/all, persisted to config) + the 3 runtime toggles (mute/trust/safe — same setters as the IM commands)', () => {
    expect([...CLI_SUBCOMMANDS].sort()).toEqual([
      'hook', 'logs', 'mode', 'mute', 'run', 'safe', 'setup', 'start', 'status', 'stop', 'trust', 'url',
    ]);
  });
});
