import { describe, it, expect } from 'vitest';
import { CONFIRM } from '../toggle';
import { SAFE_TOGGLE_MESSAGE } from '../../../kernel/permission/policy-engine';

// `tlive safe on|off` and the IM `/safe on|off` flip the SAME daemon state, so
// they must not describe it differently. Two hand-written copies of the wording
// is exactly how one gets updated and the other silently lies.
describe('safe toggle wording', () => {
  it('the CLI reuses the shared message instead of its own copy', () => {
    expect(CONFIRM.safe[0]).toBe(SAFE_TOGGLE_MESSAGE.on);
    expect(CONFIRM.safe[1]).toBe(SAFE_TOGGLE_MESSAGE.off);
  });
});
