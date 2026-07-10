import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const A = join(__dirname, '..', '..', 'plugins', 'claude', 'plugins', 'tlive', 'skills', 'tlive', 'SKILL.md');
const B = join(__dirname, '..', '..', 'plugins', 'codex', 'plugins', 'tlive', 'skills', 'tlive', 'SKILL.md');

describe('tlive skill', () => {
  it('两份存在且内容一致', () => {
    const a = readFileSync(A, 'utf-8');
    expect(a).toBe(readFileSync(B, 'utf-8'));
    expect(a).toMatch(/^---\nname: tlive\n/);
    expect(a).toContain('description:');
  });
  it('覆盖核心话题', () => {
    const s = readFileSync(A, 'utf-8');
    for (const kw of ['tlive setup', 'tlive status', 'tlive run', 'tlive url', 'autoStart', 'trust', '审批']) expect(s).toContain(kw);
  });
  it('skill 含 onboarding 段(config schema + 引导流程)', () => {
    const s = readFileSync(A, 'utf-8');
    for (const kw of ['首次上手', 'adapters', 'chatIdAllowList', 'appSecret']) expect(s).toContain(kw);
  });
});
