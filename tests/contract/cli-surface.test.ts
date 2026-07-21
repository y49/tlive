import { describe, it, expect } from 'vitest';
import { CLI_SUBCOMMANDS } from '../../src/kernel/contracts/cli-surface.js';
describe('v2 CLI surface', () => {
  it('is exactly the 8 core subcommands + the 4 runtime toggles (perm/trust/safe/desktop, added 2026-07-21 — same setters as the IM commands)', () => {
    expect([...CLI_SUBCOMMANDS].sort()).toEqual([
      'desktop', 'hook', 'logs', 'perm', 'run', 'safe', 'setup', 'start', 'status', 'stop', 'trust', 'url',
    ]);
  });
});
