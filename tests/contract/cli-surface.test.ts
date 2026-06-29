import { describe, it, expect } from 'vitest';
import { FROZEN_CLI_SUBCOMMANDS, type FrozenSubcommand } from '../../src/kernel/contracts/cli-surface';

describe('CLI surface contract', () => {
  it('exactly the agreed subcommand set', () => {
    const expected: FrozenSubcommand[] = [
      'start', 'stop', 'restart', 'status', 'doctor', 'daemon-logs',
      'workspace',
      'setup', 'install-integrations',
      'hook',
      'approve',
      'version', 'update',
    ];
    expect([...FROZEN_CLI_SUBCOMMANDS].sort()).toEqual([...expected].sort());
  });

  it('subcommand count is 13', () => {
    expect(FROZEN_CLI_SUBCOMMANDS).toHaveLength(13);
  });
});
