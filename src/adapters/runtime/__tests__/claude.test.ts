import { describe, it, expect, vi } from 'vitest';
import { ClaudeRuntimeAdapter } from '../claude';

// Mock the SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'sdk-fake-id' };
    yield { type: 'result', subtype: 'success' };
  }),
}));

describe('ClaudeRuntimeAdapter', () => {
  it('start surfaces sdkSessionId via session_ready event then through start return', async () => {
    const a = new ClaudeRuntimeAdapter({ permissionPromptToolName: 'mcp__tlive__approve' });
    const out = await a.start({ workspaceDir: '/tmp/foo' });
    expect(out.providerSessionId).toBe('sdk-fake-id');
  });

  it('events() yields session_ready first', async () => {
    const a = new ClaudeRuntimeAdapter({ permissionPromptToolName: 'mcp__tlive__approve' });
    await a.start({ workspaceDir: '/tmp/foo' });
    const evs: Array<{ kind: string }> = [];
    for await (const e of a.events()) {
      evs.push(e);
      if (evs.length >= 2) break;
    }
    expect(evs[0].kind).toBe('session_ready');
  });
});
