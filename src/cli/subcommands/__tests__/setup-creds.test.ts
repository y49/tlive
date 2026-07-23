import { describe, it, expect } from 'vitest';
import { buildFeishuCreds } from '../setup';

describe('buildFeishuCreds', () => {
  it('returns undefined unless both appId and appSecret are present', () => {
    expect(buildFeishuCreds('', 's', 'oc_1')).toBeUndefined();
    expect(buildFeishuCreds('a', '', 'oc_1')).toBeUndefined();
    expect(buildFeishuCreds('', '', '')).toBeUndefined();
  });
  it('includes chatId only when provided (the destination the bot posts to)', () => {
    expect(buildFeishuCreds('a', 's', 'oc_1')).toEqual({ appId: 'a', appSecret: 's', chatId: 'oc_1' });
    expect(buildFeishuCreds('a', 's', '')).toEqual({ appId: 'a', appSecret: 's' });
  });
});
