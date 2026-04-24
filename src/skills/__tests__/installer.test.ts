// src/skills/__tests__/installer.test.ts
//
// Verify the Claude/Codex installer writes the expected template files and
// patches settings.json / config.toml idempotently. All filesystem work is
// scoped to a tmpdir via the `destRoot` override.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  installClaude, installCodex, installAll,
  listClaudeSkills, installClaudeSkill, removeClaudeSkill,
  writeClaudeAgent, removeClaudeAgent,
} from '../installer.js';

describe('skills installer', () => {
  let work: string;
  let claudeRoot: string;
  let codexRoot: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'tlive-install-'));
    claudeRoot = join(work, 'claude');
    codexRoot = join(work, 'codex');
    mkdirSync(claudeRoot, { recursive: true });
    mkdirSync(codexRoot, { recursive: true });
  });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  it('installClaude copies SKILL.md + command and patches settings.json', async () => {
    const result = await installClaude({ destRoot: claudeRoot });
    expect(result.filesWritten.length).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(claudeRoot, 'skills', 'tlive', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(claudeRoot, 'skills', 'tlive', 'commands', 'tlive.md'))).toBe(true);
    // Shell scripts were removed in favor of the cross-platform `tlive`
    // CLI — verify the scripts/ dir is NOT populated.
    expect(existsSync(join(claudeRoot, 'skills', 'tlive', 'scripts', 'handoff.sh'))).toBe(false);
    expect(existsSync(join(claudeRoot, 'skills', 'tlive', 'scripts', 'takeback.sh'))).toBe(false);

    const settingsPath = join(claudeRoot, 'settings.json');
    expect(result.configPatched).toBe(settingsPath);
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      mcpServers: { tlive: { command: string; args: string[] } };
    };
    expect(parsed.mcpServers.tlive.command).toBe('tlive');
    expect(parsed.mcpServers.tlive.args).toEqual(['mcp']);
  });

  it('installClaude preserves existing settings keys and foreign mcpServers', async () => {
    const settingsPath = join(claudeRoot, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      theme: 'dark',
      mcpServers: {
        other: { command: 'other', args: ['x'] },
      },
    }, null, 2));

    await installClaude({ destRoot: claudeRoot });
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      theme: string;
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcpServers.other).toEqual({ command: 'other', args: ['x'] });
    expect((parsed.mcpServers.tlive as { command: string }).command).toBe('tlive');
  });

  it('installCodex writes tlive.md and appends the [mcp_servers.tlive] TOML section', async () => {
    const result = await installCodex({ destRoot: codexRoot });
    expect(existsSync(join(codexRoot, 'prompts', 'tlive.md'))).toBe(true);
    const tomlPath = join(codexRoot, 'config.toml');
    expect(result.configPatched).toBe(tomlPath);
    const toml = readFileSync(tomlPath, 'utf8');
    expect(toml).toMatch(/\[mcp_servers\.tlive\]/);
    expect(toml).toMatch(/command\s*=\s*"tlive"/);
    expect(toml).toMatch(/args\s*=\s*\["mcp"\]/);
  });

  it('installCodex preserves foreign TOML sections and rewrites in place', async () => {
    const tomlPath = join(codexRoot, 'config.toml');
    writeFileSync(tomlPath, [
      '# user config',
      '[profiles.default]',
      'provider = "openai"',
      '',
      '[mcp_servers.tlive]',
      'command = "stale"',
      'args = ["old"]',
      '',
      '[mcp_servers.other]',
      'command = "other"',
      '',
    ].join('\n'));

    await installCodex({ destRoot: codexRoot });
    const out = readFileSync(tomlPath, 'utf8');
    expect(out).toMatch(/\[profiles\.default\]/);
    expect(out).toMatch(/provider = "openai"/);
    expect(out).toMatch(/\[mcp_servers\.other\]/);
    expect(out).toMatch(/command\s*=\s*"tlive"/);
    expect(out).not.toMatch(/command = "stale"/);
    expect(out).not.toMatch(/args = \["old"\]/);
  });

  it('installAll runs both sides', async () => {
    const r = await installAll({ claudeRoot, codexRoot });
    expect(r.claude.configPatched).toContain('settings.json');
    expect(r.codex.configPatched).toContain('config.toml');
  });

  it('installClaude is idempotent', async () => {
    await installClaude({ destRoot: claudeRoot });
    await installClaude({ destRoot: claudeRoot });
    const parsed = JSON.parse(readFileSync(join(claudeRoot, 'settings.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(parsed.mcpServers)).toEqual(['tlive']);
  });

  it('skill list/install/remove round-trip via ~/.claude/skills', async () => {
    expect(await listClaudeSkills(claudeRoot)).toEqual([]);

    // Pre-seed a fake skill source directory.
    const src = join(work, 'src-skill');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), '---\nname: demo\n---\nbody\n');

    const entry = await installClaudeSkill(src, { destRoot: claudeRoot });
    expect(entry.name).toBe('src-skill');
    const list = await listClaudeSkills(claudeRoot);
    expect(list.map((s) => s.name)).toContain('src-skill');

    const removed = await removeClaudeSkill('src-skill', { destRoot: claudeRoot });
    expect(removed).toBe(true);
    expect(await listClaudeSkills(claudeRoot)).toEqual([]);
  });

  it('installClaudeSkill refuses URLs', async () => {
    await expect(
      installClaudeSkill('https://example.com/skill.md', { destRoot: claudeRoot }),
    ).rejects.toThrow(/URL skills/);
  });

  it('installClaudeSkill can install a single .md file', async () => {
    const md = join(work, 'single.md');
    writeFileSync(md, '# a single-file skill');
    const entry = await installClaudeSkill(md, { destRoot: claudeRoot, name: 'single' });
    expect(existsSync(join(entry.path, 'SKILL.md'))).toBe(true);
  });

  it('agent create/remove writes markdown with frontmatter', async () => {
    const p = await writeClaudeAgent(
      { name: 'reviewer', description: 'Review PRs', model: 'claude', tools: ['Read', 'Edit'] },
      { destRoot: claudeRoot },
    );
    const body = readFileSync(p, 'utf8');
    expect(body).toMatch(/^---/);
    expect(body).toMatch(/name: reviewer/);
    expect(body).toMatch(/description: Review PRs/);
    expect(body).toMatch(/model: claude/);
    expect(body).toMatch(/tools: \["Read", "Edit"\]/);

    const removed = await removeClaudeAgent('reviewer', { destRoot: claudeRoot });
    expect(removed).toBe(true);
    const missing = await removeClaudeAgent('reviewer', { destRoot: claudeRoot });
    expect(missing).toBe(false);
  });
});
