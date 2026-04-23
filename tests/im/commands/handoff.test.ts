import { describe, it, expect } from 'vitest';
import { handoffCmd } from '../../../src/im/commands/handoff.js';
import { handoffToMeCmd } from '../../../src/im/commands/handoff-to-me.js';

describe('/handoff (alias of /handoff-to-me)', () => {
  it('shares the run function and role', () => {
    expect(handoffCmd.run).toBe(handoffToMeCmd.run);
    expect(handoffCmd.role).toBe(handoffToMeCmd.role);
    expect(handoffCmd.name).toBe('handoff');
  });
});
