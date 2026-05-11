import { describe, it, expect, vi } from 'vitest';

const stop = vi.fn();
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { im = { v1: { message: { create: vi.fn(async () => ({ data: { message_id: 'fmid-1' } })), patch: vi.fn() } } }; },
  WSClient: class {
    start = vi.fn(); stop = stop;
  },
  EventDispatcher: class { register = vi.fn(); },
}));

import { FeishuAdapter } from '../feishu';

describe('FeishuAdapter', () => {
  it('start + stop', async () => {
    const a = new FeishuAdapter({ appId: 'A', appSecret: 'S' });
    await a.start();
    expect(a.isConnected()).toBe('connected');
    await a.stop();
    expect(a.isConnected()).toBe('idle');
    expect(stop).toHaveBeenCalled();
  });

  it('stop is idempotent', async () => {
    const a = new FeishuAdapter({ appId: 'A', appSecret: 'S' });
    await a.start();
    await a.stop(); await a.stop();
    expect(a.isConnected()).toBe('idle');
  });
});
