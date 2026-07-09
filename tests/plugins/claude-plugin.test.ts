import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const MK = join(ROOT, 'plugins', 'claude');
const P = join(MK, 'plugins', 'tlive');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));

describe('plugins/claude marketplace', () => {
  it('marketplace.json: name tlive,source ./plugins/tlive', () => {
    const m = read(join(MK, '.claude-plugin', 'marketplace.json'));
    expect(m.name).toBe('tlive');
    expect(m.plugins[0].name).toBe('tlive');
    expect(m.plugins[0].source).toBe('./plugins/tlive');
  });
  it('plugin.json: name/description/version 存在', () => {
    const p = read(join(P, '.claude-plugin', 'plugin.json'));
    expect(p.name).toBe('tlive');
    expect(typeof p.version).toBe('string');
  });
  it('hooks.json: 与直写同集的 9 事件 + 关键 timeout', () => {
    const h = read(join(P, 'hooks', 'hooks.json')).hooks;
    expect(Object.keys(h).sort()).toEqual(['Notification','PostToolUse','PostToolUseFailure','PreToolUse','SessionEnd','SessionStart','Stop','StopFailure','UserPromptSubmit'].sort());
    expect(h.PreToolUse[0].matcher).toBe('*');
    expect(h.PreToolUse[0].hooks[0]).toMatchObject({ type: 'command', command: 'tlive hook pre-tool-use', timeout: 600 });
    expect(h.Stop[0].hooks[0].timeout).toBe(180);
    expect(h.StopFailure[0].hooks[0].command).toBe('tlive hook stop-failure');
  });
  it('commands: url.md / status.md 存在且是 md 带 bash 调用', () => {
    for (const f of ['url.md', 'status.md']) {
      const s = readFileSync(join(P, 'commands', f), 'utf-8');
      expect(s).toContain('tlive');
    }
  });
  it('package.json files 含 plugins/', () => {
    expect(read(join(ROOT, 'package.json')).files).toContain('plugins/');
  });
});
