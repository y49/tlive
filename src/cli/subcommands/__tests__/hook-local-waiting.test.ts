import { describe, it, expect } from 'vitest';
import { localWaitingFields } from '../hook';

// The shim and the daemon ship in one package but do NOT update together: the
// daemon is a long-running process and nothing restarts it on upgrade — the
// postinstall script only checks the Node version. So a build always produces a
// window of new shim talking to old daemon, ended only by a manual
// `tlive stop; tlive start` that nobody is prompted to run.
//
// That makes renaming a wire field a silent regression: an older daemon reads
// `permissionPrompt` and knows nothing of `localWaiting`, so every native
// permission dialog would lose its desktop toast and dashboard card — in
// `notify`, the DEFAULT rung — until the daemon happened to be restarted.
// Hence the duplicate: `permissionPrompt` is carried alongside, meaning nothing
// to a current daemon and everything to an older one. It can be dropped once
// daemons older than this release are not a concern.
describe('localWaitingFields — wire compatibility with a daemon that has not restarted', () => {
  it('an approval still carries the boolean an older daemon reads', () => {
    expect(localWaitingFields('approval')).toEqual({ permissionPrompt: true, localWaiting: 'approval' });
  });

  // The new kinds must NOT set it. An older daemon would run its permission
  // chain for them — asking gates that structurally cannot apply — and a
  // teammate's relayed approval would come out suppressed in a holding rung,
  // which is worse than the silence it already has there.
  it.each(['relayed-approval', 'question', 'elsewhere'] as const)('%s carries only the new field', (w) => {
    expect(localWaitingFields(w)).toEqual({ localWaiting: w });
  });

  it('nothing waiting → no fields at all', () => {
    expect(localWaitingFields(undefined)).toEqual({});
  });
});
