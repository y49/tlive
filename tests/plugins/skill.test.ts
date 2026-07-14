import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const A = join(__dirname, '..', '..', 'plugins', 'claude', 'plugins', 'tlive', 'skills', 'tlive', 'SKILL.md');
const B = join(__dirname, '..', '..', 'plugins', 'codex', 'plugins', 'tlive', 'skills', 'tlive', 'SKILL.md');

describe('tlive skill', () => {
  it('both copies exist and are identical', () => {
    const a = readFileSync(A, 'utf-8');
    expect(a).toBe(readFileSync(B, 'utf-8'));
    expect(a).toMatch(/^---\nname: tlive\n/);
    expect(a).toContain('description:');
  });
  it('covers the core topics (companion semantics, no retired trust flow)', () => {
    const s = readFileSync(A, 'utf-8');
    for (const kw of ['tlive setup', 'tlive status', 'tlive run', 'tlive url', 'autoStart', '/trust on', 'companion', 'Never auto-allow']) expect(s).toContain(kw);
    expect(s).not.toContain('hooks review'); // Codex trust flow is retired
  });
  it('contains the onboarding section (config schema + guided flow)', () => {
    const s = readFileSync(A, 'utf-8');
    for (const kw of ['onboarding', 'adapters', 'chatIdAllowList', 'appSecret']) expect(s).toContain(kw);
  });
});
