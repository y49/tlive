// Condition-based waiting for tests.
//
// Fixed `setTimeout` waits before an arrival assertion are the project's main
// source of Windows CI flake: named pipes are slower than unix sockets, so a
// margin that holds on Linux does not hold there (#45, #59's sibling red).
// vitest's default waitFor timeout is 1s, which is too tight for daemon
// bootstrap over a pipe.
//
// Use this for ARRIVAL assertions — "X has appeared". Do NOT use it for
// ABSENCE assertions — "X did not happen" needs a real elapsed interval, and a
// condition that is already true returns immediately, asserting nothing.

import { vi } from 'vitest';

const TIMEOUT_MS = 5000;
const INTERVAL_MS = 20;

export function until(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: TIMEOUT_MS, interval: INTERVAL_MS }) as Promise<void>;
}
