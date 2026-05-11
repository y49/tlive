import { describe, it, expect } from 'vitest';
import type { RuntimeEvent } from '../../src/kernel/contracts/runtime-event';

describe('RuntimeEvent contract', () => {
  it('union covers exactly 9 kinds', () => {
    const samples: RuntimeEvent[] = [
      { kind: 'text_delta', delta: 'hi' },
      { kind: 'thinking_delta', delta: '...' },
      { kind: 'tool_use_start', toolName: 'Bash', input: {}, toolUseId: 't1' },
      { kind: 'tool_use_result', toolUseId: 't1', output: 'ok', isError: false },
      { kind: 'permission_request', toolName: 'Bash', input: {}, requestId: 'r1' },
      { kind: 'turn_start' },
      { kind: 'turn_end' },
      { kind: 'session_ready', providerSessionId: 'p1' },
      { kind: 'error', message: 'oops', recoverable: true },
    ];
    expect(samples).toHaveLength(9);
    const kinds = new Set(samples.map((e) => e.kind));
    expect(kinds.size).toBe(9);
  });

  it('turn_end accepts optional usage', () => {
    const e: RuntimeEvent = {
      kind: 'turn_end',
      usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.01 },
    };
    expect(e.kind).toBe('turn_end');
  });
});
