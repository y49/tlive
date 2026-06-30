import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'preuninstall.js');

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tlive-uninstall-')); });

function seedSettings(obj: unknown): string {
  const dir = join(home, '.claude');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'settings.json');
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

function runPreuninstall(): void {
  execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
}

describe('preuninstall hook removal', () => {
  it('removes _tlive hooks, preserves others, drops emptied events', () => {
    const p = seedSettings({
      hooks: {
        PreToolUse: [
          { matcher: '*', hooks: [{ type: 'command', command: 'tlive hook pre-tool-use', _tlive: true }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool' }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'tlive hook stop', _tlive: true }] }],
      },
      otherSetting: 'keep-me',
    });
    runPreuninstall();
    const after = JSON.parse(readFileSync(p, 'utf-8'));
    // _tlive PreToolUse group gone, non-tlive group kept
    expect(after.hooks.PreToolUse).toHaveLength(1);
    expect(after.hooks.PreToolUse[0].hooks[0].command).toBe('other-tool');
    // Stop had only a _tlive group → event key deleted
    expect(after.hooks.Stop).toBeUndefined();
    // unrelated settings preserved
    expect(after.otherSetting).toBe('keep-me');
  });

  it('no-ops when settings.json is absent', () => {
    expect(() => runPreuninstall()).not.toThrow();
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
  });
});
