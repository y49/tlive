import { describe, it, expect, vi, afterEach } from 'vitest';

describe('setup --hooks-only (plugin orchestration)', () => {
  afterEach(() => vi.restoreAllMocks());
  it('vendor CLI 全缺时不抛,打印指引', async () => {
    const outs: string[] = [];
    const w = vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => { outs.push(String(s)); return true; });
    const prevPath = process.env.PATH;
    process.env.PATH = '/nonexistent';  // claude/codex 都探测失败
    try {
      const { runSetup } = await import('../setup');
      await runSetup(['--hooks-only']);
      expect(outs.join('')).toMatch(/⚠/);
    } finally { process.env.PATH = prevPath; w.mockRestore(); }
  });
});

describe('hooksOnlySelection (--hooks-only vendor flags)', () => {
  it('no flag → install both (unchanged default)', async () => {
    const { hooksOnlySelection } = await import('../setup');
    expect(hooksOnlySelection(['--hooks-only'])).toEqual({ claude: true, codex: true });
  });
  it('--claude → Claude only', async () => {
    const { hooksOnlySelection } = await import('../setup');
    expect(hooksOnlySelection(['--hooks-only', '--claude'])).toEqual({ claude: true, codex: false });
  });
  it('--codex → Codex only', async () => {
    const { hooksOnlySelection } = await import('../setup');
    expect(hooksOnlySelection(['--hooks-only', '--codex'])).toEqual({ claude: false, codex: true });
  });
  it('both flags → both', async () => {
    const { hooksOnlySelection } = await import('../setup');
    expect(hooksOnlySelection(['--hooks-only', '--claude', '--codex'])).toEqual({ claude: true, codex: true });
  });
});

describe('installClaudePlugin (refresh already-installed plugin)', () => {
  it('runs marketplace update + plugin update when the plugin is already installed', async () => {
    const { installClaudePlugin } = await import('../../../kernel/integrations/plugin-install.js');
    const calls: string[][] = [];
    const run = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args[0] === 'plugin' && args[1] === 'install') return { ok: false, output: 'tlive is already installed' };
      if (args[0] === 'plugin' && args[1] === 'update') return { ok: true, output: 'updated from 2.0.0 to 2.3.0' };
      return { ok: true, output: '' };
    };
    const r = installClaudePlugin(run);
    expect(r.ok).toBe(true);
    const flat = calls.map((c) => c.join(' '));
    expect(flat).toContain('claude plugin marketplace update tlive');
    expect(flat).toContain('claude plugin update tlive@tlive');
  });

  it('fresh install (not already present) does not call update', async () => {
    const { installClaudePlugin } = await import('../../../kernel/integrations/plugin-install.js');
    const calls: string[][] = [];
    const run = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { ok: true, output: 'installed' };
    };
    const r = installClaudePlugin(run);
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.join(' '))).not.toContain('claude plugin update tlive@tlive');
  });
});
