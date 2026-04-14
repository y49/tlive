import { describe, it, expect } from 'vitest';
import { ClaudeAdapter } from '../../src/sdk/claudeAdapter.js';

describe('ClaudeAdapter', () => {
  it('generates correct session-id args', () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.getSessionIdArgs('abc-123')).toEqual([
      '--session-id',
      'abc-123',
    ]);
  });

  it('generates correct resume args', () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.getResumeArgs('abc-123')).toEqual([
      '--resume',
      '--session-id',
      'abc-123',
    ]);
  });

  it('builds spawn args with extra args', () => {
    const adapter = new ClaudeAdapter();
    const args = adapter.spawnArgs({
      sessionId: 'sid',
      cwd: '/proj',
      args: ['--verbose'],
    });
    expect(args).toEqual(['--session-id', 'sid', '--verbose']);
  });

  it('resolves executable from env', async () => {
    const adapter = new ClaudeAdapter();
    process.env.CTI_CLAUDE_CODE_EXECUTABLE = '/usr/local/bin/claude-test';
    const path = await adapter.resolveExecutable();
    expect(path).toBe('/usr/local/bin/claude-test');
    delete process.env.CTI_CLAUDE_CODE_EXECUTABLE;
  });

  it('computes session dir from workdir path', () => {
    const adapter = new ClaudeAdapter();
    const dir = adapter.getSessionDir('/home/user/myproject');
    expect(dir).toMatch(/\.claude\/projects\/-home-user-myproject$/);
  });

  describe('extractThinkingEvents', () => {
    it('emits tool_use trigger for assistant event with tool_use block', () => {
      const adapter = new ClaudeAdapter();
      const event = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
          ],
        },
      };
      expect(adapter.extractThinkingEvents(event)).toEqual([
        { type: 'tool_use', toolUseId: 'tool-1' },
      ]);
    });

    it('emits text trigger for assistant event with text block', () => {
      const adapter = new ClaudeAdapter();
      const event = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
        },
      };
      expect(adapter.extractThinkingEvents(event)).toEqual([
        { type: 'text' },
      ]);
    });

    it('emits tool_result trigger for user event with tool_result block', () => {
      const adapter = new ClaudeAdapter();
      const event = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
          ],
        },
      };
      expect(adapter.extractThinkingEvents(event)).toEqual([
        { type: 'tool_result', toolUseId: 'tool-1' },
      ]);
    });

    it('emits mixed sequence preserving block order', () => {
      const adapter = new ClaudeAdapter();
      const event = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'thinking…' },
            { type: 'tool_use', id: 'tool-a', name: 'Read', input: {} },
            { type: 'tool_use', id: 'tool-b', name: 'Grep', input: {} },
          ],
        },
      };
      expect(adapter.extractThinkingEvents(event)).toEqual([
        { type: 'text' },
        { type: 'tool_use', toolUseId: 'tool-a' },
        { type: 'tool_use', toolUseId: 'tool-b' },
      ]);
    });

    it('returns empty array for unknown event type', () => {
      const adapter = new ClaudeAdapter();
      expect(adapter.extractThinkingEvents({ type: 'system', message: {} })).toEqual([]);
    });

    it('returns empty array when message has no content blocks', () => {
      const adapter = new ClaudeAdapter();
      expect(adapter.extractThinkingEvents({ type: 'assistant' })).toEqual([]);
      expect(adapter.extractThinkingEvents({ type: 'assistant', message: null })).toEqual([]);
    });

    it('ignores tool_use blocks missing an id', () => {
      const adapter = new ClaudeAdapter();
      const event = {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: {} }, // no id
            { type: 'tool_use', id: 'tool-ok', name: 'Read', input: {} },
          ],
        },
      };
      expect(adapter.extractThinkingEvents(event)).toEqual([
        { type: 'tool_use', toolUseId: 'tool-ok' },
      ]);
    });
  });

  describe('normalizeSessionEvent', () => {
    const adapter = new ClaudeAdapter();

    it('produces NormalizedMessage for an assistant text event', () => {
      const event = {
        uuid: 'u1',
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      };
      const out = adapter.normalizeSessionEvent!(event, { sessionId: 'sess-1' });
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]).toMatchObject({ kind: 'text', text: 'Hello', provider: 'claude', sessionId: 'sess-1' });
    });

    it('produces [] for an event with no content', () => {
      const event = { uuid: 'u2', type: 'assistant', message: { content: [] } };
      const out = adapter.normalizeSessionEvent!(event, { sessionId: 'sess-2' });
      expect(out).toEqual([]);
    });

    it('produces [] for an event missing required fields', () => {
      const event = { type: 'assistant' };  // missing uuid
      const out = adapter.normalizeSessionEvent!(event);
      expect(out).toEqual([]);
    });
  });
});
