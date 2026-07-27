import { describe, it, expect } from 'vitest';
import { LocalPrompts } from '../local-prompts.js';

// Tracks CC-native permission dialogs the daemon knows about only via
// Notification(permission_prompt) — notify mode, or a full-mode immediate
// defer (issue #49). One dialog per session key (CC's dialog is modal).

describe('LocalPrompts', () => {
  it('note → has/count; clear removes and reports it', () => {
    const lp = new LocalPrompts();
    expect(lp.count()).toBe(0);
    lp.note('k1', 's1');
    expect(lp.has('k1', 's1')).toBe(true);
    expect(lp.count()).toBe(1);
    expect(lp.clear({ key: 'k1', sessionId: 's1' })).toBe(true);
    expect(lp.count()).toBe(0);
    expect(lp.clear({ key: 'k1' })).toBe(false); // already gone
  });

  it('sessionId matching is conservative-wildcard (either side missing = match) — same rule as the router', () => {
    const lp = new LocalPrompts();
    lp.note('k1', 's1');
    expect(lp.has('k1')).toBe(true); // caller has no sessionId → wildcard
    expect(lp.has('k1', 's2')).toBe(false); // both present and different → no match
    expect(lp.clear({ key: 'k1', sessionId: 's2' })).toBe(false);
    expect(lp.clear({ key: 'k1' })).toBe(true); // wildcard clears
  });

  it('note without sessionId matches any clear (wildcard from the entry side too)', () => {
    const lp = new LocalPrompts();
    lp.note('k1');
    expect(lp.has('k1', 's9')).toBe(true);
    expect(lp.clear({ key: 'k1', sessionId: 's9' })).toBe(true);
  });

  it('one slot per key — a re-note replaces (CC dialogs are modal, one at a time per session)', () => {
    const lp = new LocalPrompts();
    lp.note('k1', 's1');
    lp.note('k1', 's2');
    expect(lp.count()).toBe(1);
    expect(lp.has('k1', 's1')).toBe(false);
    expect(lp.has('k1', 's2')).toBe(true);
  });

  it('keys are independent', () => {
    const lp = new LocalPrompts();
    lp.note('k1');
    lp.note('k2');
    expect(lp.count()).toBe(2);
    lp.clear({ key: 'k1' });
    expect(lp.has('k2')).toBe(true);
  });
});
