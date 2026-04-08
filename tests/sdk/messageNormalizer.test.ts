// tests/sdk/messageNormalizer.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeSessionLine, formatForIM } from '../../src/sdk/messageNormalizer.js';

describe('normalizeSessionLine', () => {
  it('normalizes assistant text block', () => {
    const msgs = normalizeSessionLine(
      { uuid: 'u1', type: 'assistant', message: [{ type: 'text', text: 'Hello world' }] },
      'claude', 'sid-1');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ kind: 'text', provider: 'claude', sessionId: 'sid-1', text: 'Hello world' });
  });

  it('normalizes assistant tool_use block', () => {
    const msgs = normalizeSessionLine(
      { uuid: 'u2', type: 'assistant', message: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }] },
      'claude', 'sid-2');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'ls' } });
  });

  it('normalizes user tool_result block', () => {
    const msgs = normalizeSessionLine(
      { uuid: 'u3', type: 'user', message: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'file.txt' }] },
      'claude', 'sid-3');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ kind: 'tool_result', parentToolUseId: 'tu-1', text: 'file.txt' });
  });

  it('handles mixed assistant blocks', () => {
    const msgs = normalizeSessionLine(
      { uuid: 'u4', type: 'assistant', message: [
        { type: 'text', text: 'I will run a command' },
        { type: 'tool_use', id: 'tu-2', name: 'Bash', input: { command: 'echo hi' } },
      ]}, 'claude', 'sid-4');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].kind).toBe('text');
    expect(msgs[1].kind).toBe('tool_use');
  });
});

describe('formatForIM', () => {
  it('formats text message', () => {
    expect(formatForIM({ kind: 'text', provider: 'claude', sessionId: 's', text: 'hi' })).toBe('hi');
  });

  it('formats permission request with command', () => {
    const out = formatForIM({
      kind: 'permission_request', provider: 'claude', sessionId: 's',
      toolName: 'Bash', toolInput: { command: 'rm -rf node_modules' },
    });
    expect(out).toContain('Permission: Bash');
    expect(out).toContain('rm -rf node_modules');
  });

  it('formats complete', () => {
    expect(formatForIM({ kind: 'complete', provider: 'claude', sessionId: 's' })).toBe('✅ Session complete');
  });
});
