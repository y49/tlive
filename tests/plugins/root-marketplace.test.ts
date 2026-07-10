import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('repo-root marketplace (GitHub direct install)', () => {
  it('name tlive,source 指向 CC 插件目录', () => {
    const m = JSON.parse(readFileSync(join(__dirname, '..', '..', '.claude-plugin', 'marketplace.json'), 'utf-8'));
    expect(m.name).toBe('tlive');
    expect(m.plugins[0]).toMatchObject({ name: 'tlive', source: './plugins/claude/plugins/tlive' });
  });
});
