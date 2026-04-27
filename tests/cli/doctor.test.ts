import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEnvKeys } from '../../src/cli/doctor.js';

interface Finding {
  section: string;
  level: 'ok' | 'warn' | 'fail';
  message: string;
  hint?: string;
}

describe('checkEnvKeys', () => {
  let tmpDir: string;
  let claudeHome: string;
  let codexHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tlive-doctor-'));
    claudeHome = join(tmpDir, '.claude');
    codexHome = join(tmpDir, '.codex');
    mkdirSync(claudeHome, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(env: NodeJS.ProcessEnv): Finding[] {
    const findings: Finding[] = [];
    checkEnvKeys(findings, { env, claudeHome, codexHome });
    return findings;
  }

  it('anthropic OK when ANTHROPIC_API_KEY is set', () => {
    const a = run({ ANTHROPIC_API_KEY: 'sk-ant-x' }).find((f) => f.section === 'anthropic');
    expect(a?.level).toBe('ok');
    expect(a?.message).toContain('ANTHROPIC_API_KEY');
  });

  it('anthropic OK when CLAUDE_CODE_OAUTH_TOKEN is set', () => {
    const a = run({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' }).find((f) => f.section === 'anthropic');
    expect(a?.level).toBe('ok');
    expect(a?.message).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('anthropic OK when ~/.claude/.credentials.json exists (claude login)', () => {
    writeFileSync(join(claudeHome, '.credentials.json'), '{"oauth":"x"}');
    const a = run({}).find((f) => f.section === 'anthropic');
    expect(a?.level).toBe('ok');
    expect(a?.message).toContain('OAuth credentials present');
  });

  it('anthropic WARN when neither env keys nor OAuth file', () => {
    const a = run({}).find((f) => f.section === 'anthropic');
    expect(a?.level).toBe('warn');
    expect(a?.hint).toContain('claude login');
  });

  it('openai OK when ~/.codex/auth.json exists', () => {
    writeFileSync(join(codexHome, 'auth.json'), '{}');
    const o = run({}).find((f) => f.section === 'openai');
    expect(o?.level).toBe('ok');
    expect(o?.message).toContain('codex/auth.json');
  });

  it('openai WARN when neither env nor codex auth', () => {
    const o = run({}).find((f) => f.section === 'openai');
    expect(o?.level).toBe('warn');
  });
});
