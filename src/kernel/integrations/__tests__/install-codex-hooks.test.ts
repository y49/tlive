import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('installCodexHooks', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  async function run(): Promise<any> {
    const home = mkdtempSync(join(tmpdir(), 'tlive-codex-'));
    dirs.push(home);
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const { installCodexHooks } = await import('../install-hooks');
      const p = installCodexHooks();
      expect(p.endsWith('/.codex/hooks.json')).toBe(true);
      return { cfg: JSON.parse(readFileSync(p, 'utf-8')), home, p };
    } finally { process.env.HOME = prev; }
  }

  it('PreToolUse: matcher * / --codex 命令 / timeout 600 / async false', async () => {
    const { cfg } = await run();
    const h = cfg.hooks.PreToolUse[0];
    expect(h.matcher).toBe('*');
    expect(h.hooks[0].command).toBe('tlive hook --codex pre-tool-use');
    expect(h.hooks[0].timeout).toBe(600);
    expect(h.hooks[0].async).toBe(false);
  });
  it('装 Stop/PostToolUse/UserPromptSubmit/SessionStart,不装 Notification/SessionEnd', async () => {
    const { cfg } = await run();
    expect(cfg.hooks.Stop[0].hooks[0].command).toBe('tlive hook --codex stop');
    expect(cfg.hooks.PostToolUse[0].hooks[0].command).toBe('tlive hook --codex post-tool-use');
    expect(cfg.hooks.UserPromptSubmit[0].hooks[0].command).toBe('tlive hook --codex user-prompt-submit');
    expect(cfg.hooks.SessionStart[0].matcher).toBe('startup|resume|clear|compact');
    expect(cfg.hooks.Notification).toBeUndefined();
    expect(cfg.hooks.SessionEnd).toBeUndefined();
  });
  it('不注入 _tlive 外来字段', async () => {
    const { cfg } = await run();
    expect(cfg.hooks.PreToolUse[0].hooks[0]._tlive).toBeUndefined();
  });
  it('幂等:二次安装不重复 tlive 组', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tlive-codex2-'));
    dirs.push(home);
    const prev = process.env.HOME; process.env.HOME = home;
    try {
      const { installCodexHooks } = await import('../install-hooks');
      installCodexHooks();
      const cfg = JSON.parse(readFileSync(installCodexHooks(), 'utf-8'));
      expect(cfg.hooks.PreToolUse.length).toBe(1);
    } finally { process.env.HOME = prev; }
  });
  it('Stop timeout ≥ 175 (shim 续跑死线之上)', async () => {
    const { cfg } = await run();
    expect(cfg.hooks.Stop[0].hooks[0].timeout).toBeGreaterThanOrEqual(175);
  });
  it('Codex 不装 failure 事件(Codex 无此事件)', async () => {
    const { cfg } = await run();
    expect(cfg.hooks.PostToolUseFailure).toBeUndefined();
    expect(cfg.hooks.StopFailure).toBeUndefined();
  });
});

describe('commandOnPath', () => {
  it('finds an executable placed on PATH, misses a bogus name', async () => {
    const { commandOnPath } = await import('../install-hooks');
    const dir = mkdtempSync(join(tmpdir(), 'tlive-path-'));
    const exe = join(dir, 'tlivefakebin');
    writeFileSync(exe, '#!/bin/sh\n');
    chmodSync(exe, 0o755);
    const prevPath = process.env.PATH;
    process.env.PATH = dir + (process.platform === 'win32' ? ';' : ':') + (prevPath ?? '');
    try {
      expect(commandOnPath('tlivefakebin')).toBe(true);
      expect(commandOnPath('tlive-definitely-not-a-real-binary-xyz')).toBe(false);
    } finally {
      process.env.PATH = prevPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
