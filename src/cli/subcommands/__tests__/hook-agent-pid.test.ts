import { describe, it, expect } from 'vitest';
import { agentPidFromEnv } from '../hook';

describe('agentPidFromEnv', () => {
  it('reads the agent pid the vendor exports to its hooks', () => {
    expect(agentPidFromEnv({ CLAUDE_PID: '28290' })).toBe(28290);
  });

  it('absent → undefined (a vendor that exports no pid stays unsweepable, not mis-swept)', () => {
    expect(agentPidFromEnv({})).toBeUndefined();
  });

  it('non-numeric → undefined', () => {
    expect(agentPidFromEnv({ CLAUDE_PID: 'nope' })).toBeUndefined();
  });

  it('0 → undefined', () => {
    // process.kill(0, 0) signals the whole process group, so a 0 must never
    // reach the liveness probe.
    expect(agentPidFromEnv({ CLAUDE_PID: '0' })).toBeUndefined();
  });
});
