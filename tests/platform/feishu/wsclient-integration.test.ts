import { describe, it, expect, vi, beforeEach } from 'vitest';

const wsClientCtor = vi.fn();
const wsClientStart = vi.fn(async () => undefined);
const wsClientClose = vi.fn();
const eventDispatcherCtor = vi.fn();
const eventDispatcherRegister = vi.fn().mockReturnThis();
const clientCtor = vi.fn();

vi.mock('@larksuiteoapi/node-sdk', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Client: vi.fn().mockImplementation(function (this: unknown, opts: unknown) { clientCtor(opts); return { im: { v1: { message: { create: vi.fn() } } } }; }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  WSClient: vi.fn().mockImplementation(function (this: unknown, opts: unknown) {
    wsClientCtor(opts);
    return { start: wsClientStart, close: wsClientClose };
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  EventDispatcher: vi.fn().mockImplementation(function (this: unknown, opts: unknown) {
    eventDispatcherCtor(opts);
    return { register: eventDispatcherRegister };
  }),
  Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
  LoggerLevel: { info: 2 },
}));

import { FeishuAdapter } from '../../../src/platform/feishu/adapter.js';
import { createLogger } from '../../../src/util/logger.js';

beforeEach(() => {
  wsClientCtor.mockClear();
  wsClientStart.mockClear();
  wsClientClose.mockClear();
  eventDispatcherCtor.mockClear();
  eventDispatcherRegister.mockClear();
  clientCtor.mockClear();
});

describe('FeishuAdapter (production lifecycle)', () => {
  it('constructor builds Client + WSClient + EventDispatcher when nothing injected', () => {
    new FeishuAdapter({ appId: 'cli_x', appSecret: 's', logger: createLogger({ sink: () => undefined }) });
    expect(clientCtor).toHaveBeenCalledWith(expect.objectContaining({ appId: 'cli_x', appSecret: 's' }));
    expect(wsClientCtor).toHaveBeenCalledWith(expect.objectContaining({ appId: 'cli_x', appSecret: 's', autoReconnect: true }));
    expect(eventDispatcherCtor).toHaveBeenCalled();
    expect(eventDispatcherRegister).toHaveBeenCalledWith(expect.objectContaining({
      'im.message.receive_v1': expect.any(Function),
      'card.action.trigger':   expect.any(Function),
    }));
  });

  it('lark: true sets Domain.Lark on WSClient', () => {
    new FeishuAdapter({ appId: 'cli_x', appSecret: 's', lark: true, logger: createLogger({ sink: () => undefined }) });
    expect(wsClientCtor).toHaveBeenCalledWith(expect.objectContaining({ domain: 'https://open.larksuite.com' }));
  });

  it('start() invokes wsClient.start with the EventDispatcher; stop() calls close()', async () => {
    const a = new FeishuAdapter({ appId: 'cli_x', appSecret: 's', logger: createLogger({ sink: () => undefined }) });
    await a.start();
    expect(wsClientStart).toHaveBeenCalledWith(expect.objectContaining({ eventDispatcher: expect.anything() }));
    await a.stop();
    expect(wsClientClose).toHaveBeenCalled();
  });

  it('isConnected() returns false before start, true after start resolves', async () => {
    const a = new FeishuAdapter({ appId: 'cli_x', appSecret: 's', logger: createLogger({ sink: () => undefined }) });
    expect(a.isConnected()).toBe(false);
    await a.start();
    expect(a.isConnected()).toBe(true);
    await a.stop();
    expect(a.isConnected()).toBe(false);
  });
});

describe('FeishuAdapter (test seams)', () => {
  it('skips internal Client construction when client injected', () => {
    new FeishuAdapter({ appId: 'cli_x', appSecret: 's', client: { fake: true } as never, bindEventDispatcher: () => undefined });
    expect(clientCtor).not.toHaveBeenCalled();
  });

  it('skips WSClient construction when bindEventDispatcher injected', () => {
    new FeishuAdapter({ appId: 'cli_x', appSecret: 's', client: { fake: true } as never, bindEventDispatcher: () => undefined });
    expect(wsClientCtor).not.toHaveBeenCalled();
    expect(eventDispatcherCtor).not.toHaveBeenCalled();
  });

  it('start()/stop() are no-ops in injected mode; isConnected() returns null', async () => {
    const a = new FeishuAdapter({ appId: 'cli_x', appSecret: 's', client: { fake: true } as never, bindEventDispatcher: () => undefined });
    await a.start();
    await a.stop();
    expect(wsClientStart).not.toHaveBeenCalled();
    expect(wsClientClose).not.toHaveBeenCalled();
    expect(a.isConnected()).toBe(null);
  });
});
