import { describe, it, expect } from 'vitest';
import { CLI_SUBCOMMANDS } from '../../src/kernel/contracts/cli-surface.js';
describe('v2 CLI surface', () => {
  it('is exactly the 8 core subcommands + the 4 runtime toggles (mute/trust/safe/desktop — same setters as the IM commands; mute renamed from perm)', () => {
    expect([...CLI_SUBCOMMANDS].sort()).toEqual([
      'desktop', 'hook', 'logs', 'mute', 'run', 'safe', 'setup', 'start', 'status', 'stop', 'trust', 'url',
    ]);
  });
});
