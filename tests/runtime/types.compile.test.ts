import { describe, it, expectTypeOf } from 'vitest';
import type {
  AgentRuntime, AgentRuntimeOptions, PermissionRequest, PermissionDecision,
} from '../../src/runtime/types.js';

describe('AgentRuntime contract (compile-only)', () => {
  it('permits a minimal runtime implementation', () => {
    const runtime: AgentRuntime = {
      provider: 'claude',
      async start() {},
      async sendInput() {},
      async stop() {},
      onEvent: () => () => {},
      onPermissionRequest: () => () => {},
      onUsage: () => () => {},
    };
    expectTypeOf(runtime.provider).toEqualTypeOf<'claude' | 'codex'>();
  });

  it('PermissionRequest.resolve accepts only the three decisions', () => {
    const decisions: PermissionDecision[] = ['allow', 'deny', 'allow_always'];
    expectTypeOf(decisions).toEqualTypeOf<PermissionDecision[]>();
  });

  it('AgentRuntimeOptions requires signal', () => {
    const opts: AgentRuntimeOptions = {
      sessionId: 's', workdir: '/a', signal: new AbortController().signal,
    };
    expectTypeOf(opts.signal).toEqualTypeOf<AbortSignal>();
  });
});
