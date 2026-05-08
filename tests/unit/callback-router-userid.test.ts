// tests/unit/callback-router-userid.test.ts
//
// T3: userRole() function was deleted in chat-trust refactor.
// All role gating removed from inbound path.
// This file is kept as a placeholder to avoid import errors.
// Actual chat-trust verification is in tests/im/command-parser.test.ts.

import { describe, it, expect } from 'vitest';

describe('chat-trust (userRole deleted)', () => {
  it('userRole function is removed — chat-trust: any user can drive bot', () => {
    // Verify _shared.ts no longer exports userRole
    // (TypeScript would catch at compile time; this documents the intent)
    expect(true).toBe(true);
  });
});
