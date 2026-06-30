import { describe, it, expect } from 'vitest';
import { CLI_SUBCOMMANDS } from '../../src/kernel/contracts/cli-surface.js';
describe('v2 CLI surface', () => {
  it('is exactly setup/start/stop/status/logs/hook', () => {
    expect([...CLI_SUBCOMMANDS].sort()).toEqual(['hook', 'logs', 'setup', 'start', 'status', 'stop']);
  });
});
