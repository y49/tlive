import { describe, it, expect } from 'vitest';
import { modeShortCircuit } from '../hook.js';
import type { HookEventName } from '../../../kernel/hook/normalizer.js';

const EVENTS: HookEventName[] = [
  'permission-request', 'post-tool-use', 'stop', 'notification',
  'session-start', 'user-prompt-submit', 'session-end',
];

describe('modeShortCircuit — the shim honours the mode posture', () => {
  it("off → '{}' for every event (tlive fully disabled: no gating, no IPC, no autostart)", () => {
    for (const ev of EVENTS) expect(modeShortCircuit('off', ev)).toBe('{}');
  });

  it("notify → '{}' for permission-request only (never gates an approval), proceed for monitoring", () => {
    // The whole point: notify silences the one *gating* hook so tlive can never
    // hold/block an approval — the approval falls straight through to CC-native
    // handling (local dialog if interactive, else CC's own auto-deny).
    expect(modeShortCircuit('notify', 'permission-request')).toBe('{}');
    // …while every monitoring/notification hook still runs (that's the "notify").
    expect(modeShortCircuit('notify', 'stop')).toBeNull();
    expect(modeShortCircuit('notify', 'post-tool-use')).toBeNull();
    expect(modeShortCircuit('notify', 'notification')).toBeNull();
    expect(modeShortCircuit('notify', 'session-start')).toBeNull();
    expect(modeShortCircuit('notify', 'user-prompt-submit')).toBeNull();
  });

  it('full → null (proceed normally) for every event — current behaviour', () => {
    for (const ev of EVENTS) expect(modeShortCircuit('full', ev)).toBeNull();
  });
});
