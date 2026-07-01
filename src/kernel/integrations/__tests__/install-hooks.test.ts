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
});
