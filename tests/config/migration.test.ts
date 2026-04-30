// tests/config/migration.test.ts
//
// v0.x → v1.0 migration. Covers:
//   - envtext fixture produces a synthesized workspace + channel block
//   - deprecated sections are dropped with a report
//   - the migrator is pure (no file IO)
//   - loader writes a backup + new config.json when invoked
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isLegacyConfig, migrateToV1, parseEnvText } from '../../src/config/migration.js';
import { loadConfig } from '../../src/config/loader.js';

describe('migration (pure)', () => {
  it('parses envtext with quotes and exports', () => {
    const env = parseEnvText(`export TL_TG_BOT_TOKEN="abc"\nTL_DEFAULT_WORKDIR='/home/u/proj'\n# comment`);
    expect(env.TL_TG_BOT_TOKEN).toBe('abc');
    expect(env.TL_DEFAULT_WORKDIR).toBe('/home/u/proj');
  });

  it('synthesizes a workspace from envtext', () => {
    const { config, report } = migrateToV1({
      envText: 'TL_TG_BOT_TOKEN=abc\nTL_DEFAULT_WORKDIR=/home/u/proj',
      defaultWorkdir: '/home/u/proj',
    });
    expect(config.version).toBe('1');
    expect(config.workspaces).toHaveLength(1);
    expect(config.workspaces[0]!.workdir).toBe('/home/u/proj');
    expect(config.channels?.telegram?.token).toBe('abc');
    expect(report.migrated).toBe(true);
  });

  it('drops deprecated sections and reports them', () => {
    const { report } = migrateToV1({
      envText: 'TL_PTY_SHELL=bash',
      jsonValue: { pty: { shell: 'bash' }, webTerminal: { port: 3000 } },
      defaultWorkdir: '/tmp',
    });
    expect(report.dropped).toContain('pty');
    expect(report.dropped).toContain('webTerminal');
    expect(report.dropped).toContain('env.TL_PTY_SHELL');
  });

  it('drops legacy discord channel block (v1.0 removed Discord support)', () => {
    const { config, report } = migrateToV1({
      envText: 'TL_DC_BOT_TOKEN=abc\nTL_DC_APP_ID=app',
      jsonValue: { discord: { token: 'abc', applicationId: 'app' } },
      defaultWorkdir: '/tmp',
    });
    expect(report.dropped).toContain('discord');
    expect(report.dropped).toContain('env.TL_DC_BOT_TOKEN');
    expect(report.dropped).toContain('env.TL_DC_APP_ID');
    // Migrated config has no discord channel.
    expect((config.channels as Record<string, unknown> | undefined)?.discord).toBeUndefined();
  });

  it('isLegacyConfig treats missing version as legacy', () => {
    expect(isLegacyConfig({ jsonValue: { foo: 1 }, defaultWorkdir: '/x' })).toBe(true);
    expect(isLegacyConfig({ jsonValue: { version: '1' }, defaultWorkdir: '/x' })).toBe(false);
  });

  it('falls back to defaultWorkdir when TL_DEFAULT_WORKDIR is empty string', () => {
    // Regression: legacy setup wizard commonly wrote `TL_DEFAULT_WORKDIR=`
    // with an empty value. `??` treated it as present and produced an empty
    // workdir that failed schema validation. Empty strings must fall through.
    const { config } = migrateToV1({
      envText: 'TL_DEFAULT_WORKDIR=\nTL_TG_BOT_TOKEN=abc',
      defaultWorkdir: '/home/u/proj',
    });
    expect(config.workspaces[0]!.workdir).toBe('/home/u/proj');
  });

  it('trims whitespace-only TL_DEFAULT_WORKDIR', () => {
    const { config } = migrateToV1({
      envText: 'TL_DEFAULT_WORKDIR=   \nTL_TG_BOT_TOKEN=abc',
      defaultWorkdir: '/home/u/proj',
    });
    expect(config.workspaces[0]!.workdir).toBe('/home/u/proj');
  });
});

describe('loadConfig (migration roundtrip)', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tlive-mig-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('writes v1 config + backs up original envtext', async () => {
    writeFileSync(join(home, 'config.env'), 'TL_TG_BOT_TOKEN=tok\nTL_DEFAULT_WORKDIR=/home/u/proj');
    const r = await loadConfig({ home, defaultWorkdir: '/home/u/proj' });
    expect(r.config.version).toBe('1');
    expect(r.config.channels?.telegram?.token).toBe('tok');
    // Backup + new json both present.
    expect(existsSync(join(home, 'config.v0-backup.env'))).toBe(true);
    expect(existsSync(join(home, 'config.json'))).toBe(true);
    const json = JSON.parse(readFileSync(join(home, 'config.json'), 'utf-8'));
    expect(json.version).toBe('1');
  });

  it('returns default config when nothing exists', async () => {
    const r = await loadConfig({ home, defaultWorkdir: '/tmp' });
    expect(r.config.version).toBe('1');
    expect(r.config.workspaces).toEqual([]);
  });

  it('validates an existing v1 config without migrating', async () => {
    const v1 = { version: '1', workspaces: [{ name: 'p', workdir: '/x' }] };
    writeFileSync(join(home, 'config.json'), JSON.stringify(v1));
    const r = await loadConfig({ home, defaultWorkdir: '/x' });
    expect(r.migration).toBeUndefined();
    expect(r.config.workspaces[0]!.name).toBe('p');
  });
});
