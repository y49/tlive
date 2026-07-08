// src/cli/subcommands/__tests__/setup-codex.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('setup --hooks-only codex detection', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

  function fakeCodexOnPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-pathbin-'));
    dirs.push(dir);
    const exe = join(dir, 'codex');
    writeFileSync(exe, '#!/bin/sh\n');
    chmodSync(exe, 0o755);
    return dir;
  }

  async function runHooksOnly(pathValue: string): Promise<{ home: string; out: string }> {
    const home = mkdtempSync(join(tmpdir(), 'tlive-setup-')); dirs.push(home);
    const prevHome = process.env.HOME, prevPath = process.env.PATH;
    process.env.HOME = home; process.env.PATH = pathValue;
    const outs: string[] = [];
    const w = vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => { outs.push(String(s)); return true; });
    try {
      const { runSetup } = await import('../setup');
      await runSetup(['--hooks-only']);
      return { home, out: outs.join('') };
    } finally { process.env.HOME = prevHome; process.env.PATH = prevPath; w.mockRestore(); }
  }

  it('codex 在 PATH 时写 ~/.codex/hooks.json 并打印 trust 引导', async () => {
    const { home, out } = await runHooksOnly(fakeCodexOnPath());
    expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(true);
    expect(out).toMatch(/codex/i);
    expect(out).toMatch(/trust|信任|review/i);
  });

  it('codex 不在 PATH 时不写 ~/.codex/hooks.json', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'tlive-emptypath-')); dirs.push(empty);
    const { home } = await runHooksOnly(empty);
    expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(false);
    // Claude hooks 仍应写(--hooks-only 总装 CC)
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(true);
  });
});
