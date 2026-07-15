import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
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
  it('plugin.json 存在, version 2.3.0', () => {
    const pkg = read(join(P, '.codex-plugin', 'plugin.json'));
    expect(pkg.name).toBe('tlive');
    expect(pkg.version).toBe('2.3.0');
  });
  it('hooks/ 目录已退役(companion 是唯一集成方式,不再靠 hook 授信)', () => {
    expect(existsSync(join(P, 'hooks'))).toBe(false);
  });
  it('skill 存在', () => {
    expect(existsSync(join(P, 'skills'))).toBe(true);
  });
});
