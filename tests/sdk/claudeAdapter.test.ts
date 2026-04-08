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
});
