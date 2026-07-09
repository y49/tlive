import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MK = join(__dirname, '..', '..', 'plugins', 'codex');
const P = join(MK, 'plugins', 'tlive');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));

describe('plugins/codex marketplace', () => {
  it('marketplace.json: local source', () => {
    const m = read(join(MK, '.agents', 'plugins', 'marketplace.json'));
    expect(m.name).toBe('tlive');
    expect(m.plugins[0]).toMatchObject({ name: 'tlive', source: { source: 'local', path: './plugins/tlive' } });
  });
  it('plugin.json 存在', () => {
    expect(read(join(P, '.codex-plugin', 'plugin.json')).name).toBe('tlive');
  });
  it('hooks.json: Codex 5 事件,--codex 命令,async:false,无 Notification/SessionEnd/Failure', () => {
    const h = read(join(P, 'hooks', 'hooks.json')).hooks;
    expect(Object.keys(h).sort()).toEqual(['PostToolUse','PreToolUse','SessionStart','Stop','UserPromptSubmit'].sort());
    expect(h.PreToolUse[0].hooks[0]).toMatchObject({ command: 'tlive hook --codex pre-tool-use', timeout: 600, async: false });
    expect(h.Stop[0].hooks[0].timeout).toBeGreaterThanOrEqual(175);
    expect(h.SessionStart[0].matcher).toBe('startup|resume|clear|compact');
    for (const ev of Object.keys(h)) for (const g of h[ev]) for (const k of g.hooks) expect(k.async).toBe(false);
  });
});
