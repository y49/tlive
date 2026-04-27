import { describe, it, expect, vi, beforeEach } from 'vitest';

const wsClientCtor = vi.fn();
const wsClientStart = vi.fn(async () => undefined);
const wsClientClose = vi.fn();
const eventDispatcherCtor = vi.fn();
const eventDispatcherRegister = vi.fn().mockReturnThis();
const clientCtor = vi.fn();

// Shared mutable state — tests manipulate this to simulate ws lifecycle.
let mockReadyState: number | null = null;
function setReadyState(s: number | null): void { mockReadyState = s; }
function makeWsConfig() {
  return {
    getWSInstance: () => (mockReadyState === null ? null : { readyState: mockReadyState }),
  };
}

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn().mockImplementation(function (this: object, opts: unknown) {
    clientCtor(opts);
    Object.assign(this, { im: { v1: { message: { create: vi.fn() } } } });
  }),
  WSClient: vi.fn().mockImplementation(function (this: object, opts: unknown) {
    wsClientCtor(opts);
    Object.assign(this, {
      start: wsClientStart,
      close: wsClientClose,
      wsConfig: makeWsConfig(),
    });
  }),
  EventDispatcher: vi.fn().mockImplementation(function (this: object, opts: unknown) {
    eventDispatcherCtor(opts);
    Object.assign(this, { register: eventDispatcherRegister });
  }),
  Domain: { Feishu: 0, Lark: 1 },
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
  setReadyState(null);
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

  it('default (lark omitted) sets Domain.Feishu (0)', () => {
    new FeishuAdapter({ appId: 'cli_x', appSecret: 's', logger: createLogger({ sink: () => undefined }) });
    expect(wsClientCtor).toHaveBeenCalledWith(expect.objectContaining({ domain: 0 }));
  });

  it('lark: true sets Domain.Lark (1) on WSClient', () => {
    new FeishuAdapter({ appId: 'cli_x', appSecret: 's', lark: true, logger: createLogger({ sink: () => undefined }) });
    expect(wsClientCtor).toHaveBeenCalledWith(expect.objectContaining({ domain: 1 }));
  });

  it('start() invokes wsClient.start with the EventDispatcher; stop() calls close()', async () => {
    const a = new FeishuAdapter({ appId: 'cli_x', appSecret: 's', logger: createLogger({ sink: () => undefined }) });
    await a.start();
    expect(wsClientStart).toHaveBeenCalledWith(expect.objectContaining({ eventDispatcher: expect.anything() }));
    await a.stop();
    expect(wsClientClose).toHaveBeenCalled();
  });

  it('isConnected() reflects underlying WebSocket readyState (not just lifecycle)', async () => {
    const a = new FeishuAdapter({ appId: 'cli_x', appSecret: 's', logger: createLogger({ sink: () => undefined }) });
    // Pre-start: no wsInstance yet
    expect(a.isConnected()).toBe(false);
    await a.start();
    // After start() resolves but before the SDK sets the wsInstance: still false
    expect(a.isConnected()).toBe(false);
    // SDK reports OPEN:
    setReadyState(1);
    expect(a.isConnected()).toBe(true);
    // SDK reports CONNECTING (0): not yet OPEN
    setReadyState(0);
    expect(a.isConnected()).toBe(false);
    // SDK reports CLOSING (2): no longer OPEN
    setReadyState(2);
    expect(a.isConnected()).toBe(false);
    // SDK reports CLOSED (3): no longer OPEN
    setReadyState(3);
    expect(a.isConnected()).toBe(false);
    // After stop(): still false (close() invalidates the instance externally)
    setReadyState(null);
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
