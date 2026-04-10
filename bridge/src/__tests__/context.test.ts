import { describe, it, expect, beforeEach } from 'vitest';
import { initBridgeContext, getBridgeContext, type BridgeContext } from '../context.js';

const CONTEXT_KEY = '__termlive_bridge_context__';

describe('BridgeContext', () => {
  beforeEach(() => {
    delete (globalThis as any)[CONTEXT_KEY];
  });

  it('stores and retrieves context', () => {
    const ctx: BridgeContext = {
      defaultWorkdir: '/tmp',
      store: {} as any,
      llm: {} as any,
      permissions: {} as any,
    };
    initBridgeContext(ctx);
    expect(getBridgeContext()).toBe(ctx);
  });

  it('throws if not initialized', () => {
    expect(() => getBridgeContext()).toThrow('BridgeContext not initialized');
  });

  it('overwrites previous context', () => {
    const ctx1: BridgeContext = { defaultWorkdir: '/tmp', store: {} as any, llm: {} as any, permissions: {} as any };
    const ctx2: BridgeContext = { defaultWorkdir: '/tmp', store: {} as any, llm: {} as any, permissions: {} as any };
    initBridgeContext(ctx1);
    initBridgeContext(ctx2);
    expect(getBridgeContext()).toBe(ctx2);
  });
});
