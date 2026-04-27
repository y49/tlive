import { describe, it, expect } from 'vitest';
import { deriveAdminUserIdFromChatId } from '../../src/cli/setup.js';

describe('deriveAdminUserIdFromChatId', () => {
  it('returns the same id for positive Telegram chatIds (DM case)', () => {
    expect(deriveAdminUserIdFromChatId('1416643084')).toBe('1416643084');
  });

  it('returns undefined for negative Telegram chatIds (group case)', () => {
    expect(deriveAdminUserIdFromChatId('-1001234567890')).toBeUndefined();
  });

  it('returns undefined for non-numeric input', () => {
    expect(deriveAdminUserIdFromChatId('not-a-number')).toBeUndefined();
  });

  it('returns undefined for empty / undefined', () => {
    expect(deriveAdminUserIdFromChatId(undefined)).toBeUndefined();
    expect(deriveAdminUserIdFromChatId('')).toBeUndefined();
  });
});
