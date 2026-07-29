import { describe, it, expect } from 'vitest';
import { OBSERVE_IPC_TIMEOUT_MS } from '../hook';

// The observational hooks (post-tool-use, notification, user-prompt-submit,
// session-start/end, failures, subagent-start/stop) run SYNCHRONOUSLY: CC waits
// for each one to exit before continuing. PostToolUse alone fires on every tool
// call. So whatever budget the shim gives the daemon is a direct tax on the
// terminal any time the daemon is slow to answer — and these events carry no
// decision, so paying seconds for them is never the right trade.
describe('OBSERVE_IPC_TIMEOUT_MS', () => {
  it('caps what an unresponsive daemon can add to a single tool call', () => {
    expect(OBSERVE_IPC_TIMEOUT_MS).toBeLessThanOrEqual(1_500);
  });

  it('still leaves room for a healthy round trip (which is sub-millisecond)', () => {
    expect(OBSERVE_IPC_TIMEOUT_MS).toBeGreaterThanOrEqual(250);
  });
});
