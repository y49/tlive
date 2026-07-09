import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('installClaudeHooks timeout', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('writes PreToolUse timeout 600 (10-min response window)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tlive-hooks-'));
    dirs.push(home);
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      // Use a dynamic import with cache-bust to ensure fresh module with updated HOME
      const { installClaudeHooks } = await import('../install-hooks');
      const p = installClaudeHooks();
      const cfg = JSON.parse(readFileSync(p, 'utf-8'));
      const pre = cfg.hooks.PreToolUse[0].hooks[0];
      expect(pre.timeout).toBe(600);
    } finally {
      process.env.HOME = prev;
    }
  });
  it('registers UserPromptSubmit / SessionStart / SessionEnd hooks', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tlive-hooks2-'));
    dirs.push(home);
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const { installClaudeHooks } = await import('../install-hooks');
      const cfg = JSON.parse(readFileSync(installClaudeHooks(), 'utf-8'));
      expect(cfg.hooks.UserPromptSubmit[0].hooks[0].command).toBe('tlive hook user-prompt-submit');
      expect(cfg.hooks.SessionStart[0].hooks[0].command).toBe('tlive hook session-start');
      expect(cfg.hooks.SessionEnd[0].hooks[0].command).toBe('tlive hook session-end');
    } finally {
      process.env.HOME = prev;
    }
  });
  it('registers PostToolUseFailure / StopFailure hooks', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tlive-hooks3-'));
    dirs.push(home);
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const { installClaudeHooks } = await import('../install-hooks');
      const cfg = JSON.parse(readFileSync(installClaudeHooks(), 'utf-8'));
      expect(cfg.hooks.PostToolUseFailure[0].hooks[0].command).toBe('tlive hook post-tool-use-failure');
      expect(cfg.hooks.StopFailure[0].hooks[0].command).toBe('tlive hook stop-failure');
    } finally { process.env.HOME = prev; }
  });
});
