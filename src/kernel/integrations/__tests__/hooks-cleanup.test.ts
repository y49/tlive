import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('strip legacy hooks', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const home = (): string => { const d = mkdtempSync(join(tmpdir(), 'tlive-strip-')); dirs.push(d); return d; };

  it('claude: 删 _tlive 组,保留用户自有组', async () => {
    const h = home(); const prev = process.env.HOME; process.env.HOME = h;
    try {
      mkdirSync(join(h, '.claude'), { recursive: true });
      writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: 'tlive hook pre-tool-use', _tlive: true }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] },
          ],
          Stop: [{ hooks: [{ type: 'command', command: 'tlive hook stop', _tlive: true }] }],
        },
        otherKey: 1,
      }));
      const { stripLegacyClaudeHooks } = await import('../hooks-cleanup');
      expect(stripLegacyClaudeHooks()).toBe(true);
      const cfg = JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf-8'));
      expect(cfg.hooks.PreToolUse).toHaveLength(1);
      expect(cfg.hooks.PreToolUse[0].hooks[0].command).toBe('my-own-hook');
      expect(cfg.hooks.Stop).toBeUndefined();
      expect(cfg.otherKey).toBe(1);
    } finally { process.env.HOME = prev; }
  });
  it('claude: 无文件/无条目 → false 且不创建文件', async () => {
    const h = home(); const prev = process.env.HOME; process.env.HOME = h;
    try {
      const { stripLegacyClaudeHooks } = await import('../hooks-cleanup');
      expect(stripLegacyClaudeHooks()).toBe(false);
    } finally { process.env.HOME = prev; }
  });
  it('codex: 删 tlive hook 组,保留他人组', async () => {
    const h = home(); const prev = process.env.HOME; process.env.HOME = h;
    try {
      mkdirSync(join(h, '.codex'), { recursive: true });
      writeFileSync(join(h, '.codex', 'hooks.json'), JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: 'tlive hook --codex pre-tool-use', async: false }] },
            { hooks: [{ type: 'command', command: 'other-tool hook' }] },
          ],
        },
      }));
      const { stripLegacyCodexHooks } = await import('../hooks-cleanup');
      expect(stripLegacyCodexHooks()).toBe(true);
      const cfg = JSON.parse(readFileSync(join(h, '.codex', 'hooks.json'), 'utf-8'));
      expect(cfg.hooks.PreToolUse).toHaveLength(1);
      expect(cfg.hooks.PreToolUse[0].hooks[0].command).toBe('other-tool hook');
    } finally { process.env.HOME = prev; }
  });
  it('codexPluginHooksPath: 扫描版本目录解析实际路径(2.0.0 布局,E2E 实测)', async () => {
    const { codexPluginHooksPath } = await import('../hooks-cleanup');
    const h = home();
    const hooksDir = join(h, 'plugins', 'cache', 'tlive', 'tlive', '2.0.0', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'hooks.json'), '{}');
    expect(codexPluginHooksPath(h)).toBe(join(hooksDir, 'hooks.json'));
  });
  it('codexPluginHooksPath: cache 不存在 → null', async () => {
    const { codexPluginHooksPath } = await import('../hooks-cleanup');
    expect(codexPluginHooksPath(home())).toBeNull();
  });
});
