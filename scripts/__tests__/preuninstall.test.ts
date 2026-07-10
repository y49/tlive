import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'preuninstall.js');

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tlive-uninstall-')); });

function runPreuninstall(): void {
  // PATH 置空目录:tlive/claude/codex 全不可用 → 每个 best-effort 步骤都走 catch。
  const emptyPath = mkdtempSync(join(tmpdir(), 'tlive-emptypath-'));
  execFileSync(process.execPath, [SCRIPT], {
    env: { ...process.env, HOME: home, PATH: emptyPath },
    stdio: 'ignore',
  });
}

describe('preuninstall (plugin uninstall era)', () => {
  it('vendor CLI 全缺时不抛(best-effort 全兜住)', () => {
    expect(() => runPreuninstall()).not.toThrow();
  });

  it('不再触碰 ~/.claude/settings.json(直写时代已退役,legacy 清理见 docs)', () => {
    const dir = join(home, '.claude');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'settings.json');
    const original = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'tlive hook pre-tool-use', _tlive: true }] }] },
      otherSetting: 'keep-me',
    }, null, 2);
    writeFileSync(p, original);
    runPreuninstall();
    expect(readFileSync(p, 'utf-8')).toBe(original); // 一字不动
  });

  it('settings.json 缺失也不创建', () => {
    runPreuninstall();
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
  });
});
