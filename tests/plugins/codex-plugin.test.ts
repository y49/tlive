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
  it('hooks.json: Codex 5 events, PermissionRequest gating (PreToolUse retired), async:false', () => {
    const h = read(join(P, 'hooks', 'hooks.json')).hooks;
    expect(Object.keys(h).sort()).toEqual(['PermissionRequest','PostToolUse','SessionStart','Stop','UserPromptSubmit'].sort());
    // codex ≥0.143 的 PreToolUse 拒绝 ask/裸 allow 且 fail-open —— gating 必须走 PermissionRequest
    expect(h.PreToolUse).toBeUndefined();
    // vendor timeout 7320 > shim ipc max 7300 > window clamp max 7200(2h)
    expect(h.PermissionRequest[0].hooks[0]).toMatchObject({ command: 'tlive hook --codex permission-request', timeout: 7320, async: false });
    expect(h.Stop[0].hooks[0].timeout).toBeGreaterThanOrEqual(175);
    expect(h.SessionStart[0].matcher).toBe('startup|resume|clear|compact');
    for (const ev of Object.keys(h)) for (const g of h[ev]) for (const k of g.hooks) expect(k.async).toBe(false);
  });
});
