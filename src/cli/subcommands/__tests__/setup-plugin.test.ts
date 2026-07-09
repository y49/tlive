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
