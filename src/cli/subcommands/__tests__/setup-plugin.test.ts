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
