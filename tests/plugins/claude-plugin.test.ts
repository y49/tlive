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
  it('hooks.json: 12 events (PermissionRequest gating, dual-channel) + key timeouts', () => {
    const h = read(join(P, 'hooks', 'hooks.json')).hooks;
    expect(Object.keys(h).sort()).toEqual(['Notification','PermissionDenied','PermissionRequest','PostToolUse','PostToolUseFailure','SessionEnd','SessionStart','Stop','StopFailure','SubagentStart','SubagentStop','UserPromptSubmit'].sort());
    expect(h.PreToolUse).toBeUndefined(); // CC gating rides PermissionRequest now
    expect(h.PermissionRequest[0].matcher).toBe('*');
    expect(h.PermissionRequest[0].hooks[0]).toMatchObject({ type: 'command', command: 'tlive hook permission-request', timeout: 86400 });
    expect(h.PermissionDenied[0].hooks[0].command).toBe('tlive hook permission-denied');
    // async Stop hook: turn ends immediately (no keyboard-front stall), background
    // waits for a reply-to-continue and rewakes on exit 2.
    expect(h.Stop[0].hooks[0]).toMatchObject({ async: true, asyncRewake: true, timeout: 1860 });
    expect(h.StopFailure[0].hooks[0].command).toBe('tlive hook stop-failure');
    expect(h.SubagentStart[0].hooks[0].command).toBe('tlive hook subagent-start');
    expect(h.SubagentStop[0].hooks[0].command).toBe('tlive hook subagent-stop');
  });
  it('commands: url.md / status.md exist and invoke tlive', () => {
    for (const f of ['url.md', 'status.md']) {
      const s = readFileSync(join(P, 'commands', f), 'utf-8');
      expect(s).toContain('tlive');
    }
  });
  it('commands/setup.md guides through the setup steps (no retired trust step)', () => {
    const s = readFileSync(join(P, 'commands', 'setup.md'), 'utf-8');
    for (const kw of ['tlive status', 'config.json', 'tlive start', 'npm i -g tlive', 'companion']) expect(s).toContain(kw);
    expect(s).not.toContain('/hooks'); // Codex trust flow is retired
  });
  it('plugin skill and commands are English-only on the display surface (frontmatter descriptions)', () => {
    for (const f of ['commands/setup.md', 'commands/status.md', 'commands/url.md', 'skills/tlive/SKILL.md']) {
      const s = readFileSync(join(P, f), 'utf-8');
      const frontmatter = s.split('---')[1] ?? '';
      expect(frontmatter).not.toMatch(/[一-鿿]/);
    }
  });
  it('package.json files 含 plugins/', () => {
    expect(read(join(ROOT, 'package.json')).files).toContain('plugins/');
  });
});
