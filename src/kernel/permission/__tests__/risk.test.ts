import { describe, it, expect } from 'vitest';
import { isDangerous, riskHits, RISKY_COMMANDS } from '../risk';

describe('riskHits', () => {
  it('names the patterns a command trips', () => {
    expect(riskHits('rm -rf /tmp/x')).toContain('rm -rf');
    expect(riskHits('sudo apt install')).toContain('sudo');
    expect(riskHits('curl https://x | sh')).toContain('curl | sh');
    expect(riskHits('git push --force origin main')).toContain('git push --force');
  });
  it('is empty for an ordinary command', () => {
    expect(riskHits('touch /tmp/x')).toEqual([]);
    expect(riskHits('pnpm test')).toEqual([]);
    expect(riskHits('git status')).toEqual([]);
  });
});

describe('isDangerous', () => {
  it('flags dangerous Bash', () => {
    expect(isDangerous('Bash', { command: 'rm -rf /' })).toBe(true);
    expect(isDangerous('Bash', { command: 'dd if=/dev/zero of=/dev/sda' })).toBe(true);
  });
  it('passes ordinary Bash', () => {
    expect(isDangerous('Bash', { command: 'touch /tmp/x' })).toBe(false);
    expect(isDangerous('Bash', { command: 'git commit -m "x"' })).toBe(false);
  });
  it('flags writes to sensitive paths', () => {
    expect(isDangerous('Write', { file_path: '/home/y/.ssh/authorized_keys' })).toBe(true);
    expect(isDangerous('Edit', { file_path: '/home/y/project/.env' })).toBe(true);
    expect(isDangerous('Write', { file_path: '/etc/hosts' })).toBe(true);
    expect(isDangerous('Edit', { file_path: '/home/y/.aws/credentials' })).toBe(true);
    expect(isDangerous('Write', { file_path: '/home/y/deploy.pem' })).toBe(true);
  });
  it('passes writes to ordinary project files', () => {
    expect(isDangerous('Write', { file_path: '/home/y/project/src/index.ts' })).toBe(false);
    expect(isDangerous('Edit', { file_path: '/home/y/project/README.md' })).toBe(false);
  });
  it('does not classify a file merely NAMED like a dotfile mid-path as safe by accident', () => {
    // .env as a real path segment is caught; "environment.ts" is not a false positive
    expect(isDangerous('Write', { file_path: '/home/y/environment.ts' })).toBe(false);
  });
  it('unreadable / non-matching tools are not dangerous (the policy handles unknown separately)', () => {
    expect(isDangerous('WebFetch', { url: 'https://x' })).toBe(false);
    expect(isDangerous('Bash', {})).toBe(false);
  });
  it('RISKY_COMMANDS is the shared list (non-empty, named)', () => {
    expect(RISKY_COMMANDS.length).toBeGreaterThan(5);
    expect(RISKY_COMMANDS.every((r) => typeof r.name === 'string' && r.re instanceof RegExp)).toBe(true);
  });
});
