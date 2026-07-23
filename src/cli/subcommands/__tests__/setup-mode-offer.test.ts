import { describe, it, expect } from 'vitest';
import { shouldOfferFull, isAffirmative } from '../setup';

describe('shouldOfferFull', () => {
  it('offers when a channel is configured and mode is not already full', () => {
    expect(shouldOfferFull('notify', true)).toBe(true);
    expect(shouldOfferFull(undefined, true)).toBe(true); // unset → notify default
    expect(shouldOfferFull('off', true)).toBe(true);
  });
  it('does not offer when no channel is configured (nothing to approve to)', () => {
    expect(shouldOfferFull('notify', false)).toBe(false);
    expect(shouldOfferFull(undefined, false)).toBe(false);
  });
  it('does not re-offer when remote approval is already on', () => {
    expect(shouldOfferFull('full', true)).toBe(false);
  });
});

describe('isAffirmative', () => {
  it('only an explicit yes enables full', () => {
    for (const a of ['y', 'Y', 'yes', 'YES', ' yes ']) expect(isAffirmative(a)).toBe(true);
  });
  it('Enter / EOF / no / anything else keeps the safe default', () => {
    // '' is what the wizard's question() returns for both an interactive Enter
    // AND a piped-EOF — neither must silently enable remote approval.
    for (const a of ['', 'n', 'no', 'x', 'later']) expect(isAffirmative(a)).toBe(false);
  });
});
