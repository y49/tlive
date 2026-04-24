// src/config/loader.ts
//
// Load + validate the tlive config tree. Resolution order:
//   1. `$TLIVE_CONFIG_PATH` if set → JSON file.
//   2. `~/.tlive/config.json`.
//   3. Fall back to `~/.tlive/config.env` (legacy envtext) + auto-migrate.
//
// If the file is v0.x, the loader migrates in-memory and writes:
//   - `~/.tlive/config.json` (new v1)
//   - `~/.tlive/config.v0-backup.json` (original JSON if it existed)
//   - `~/.tlive/config.v0-backup.env` (original envtext if it existed)

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseConfig, type TliveConfigV1, type ParseIssue } from './schema.js';
import { migrateToV1, isLegacyConfig, type MigrationReport } from './migration.js';

export interface LoadConfigOptions {
  /** Override `~/.tlive`. */
  home?: string;
  /** Override `$TLIVE_CONFIG_PATH`. */
  configPath?: string;
  /** Default workdir when migrating a v0.x config that has none set. */
  defaultWorkdir?: string;
  /** When true, don't persist the migrated v1 config to disk. */
  noWrite?: boolean;
}

export interface LoadConfigResult {
  config: TliveConfigV1;
  /** Absolute path where the live config is persisted. */
  path: string;
  /** v0.x migration report, when migration ran. */
  migration?: MigrationReport;
  /** Non-fatal schema warnings. */
  warnings: ParseIssue[];
}

export async function loadConfig(opts: LoadConfigOptions = {}): Promise<LoadConfigResult> {
  const home = opts.home ?? join(homedir(), '.tlive');
  const explicitPath = opts.configPath ?? process.env.TLIVE_CONFIG_PATH;
  const jsonPath = explicitPath ?? join(home, 'config.json');
  const envPath = join(home, 'config.env');
  const defaultWorkdir = opts.defaultWorkdir ?? process.cwd();

  const jsonText = await readIfExists(jsonPath);
  const envText = await readIfExists(envPath);

  let jsonValue: unknown;
  if (jsonText !== null) {
    try { jsonValue = JSON.parse(jsonText); }
    catch (err) {
      throw new Error(`invalid JSON in ${jsonPath}: ${(err as Error).message}`);
    }
  }

  // Fresh install: no config anywhere. Return a minimal default.
  if (jsonValue === undefined && envText === null) {
    const config: TliveConfigV1 = {
      version: '1',
      daemon: {},
      workspaces: [],
    };
    return { config, path: jsonPath, warnings: [] };
  }

  // Is this a v0.x input? If so migrate; otherwise validate directly.
  const legacy = isLegacyConfig({ envText: envText ?? undefined, jsonValue, defaultWorkdir });
  if (legacy) {
    const { config, report } = migrateToV1({
      envText: envText ?? undefined,
      jsonValue,
      defaultWorkdir,
    });

    if (!opts.noWrite) {
      await fs.mkdir(home, { recursive: true });
      if (jsonText !== null) {
        await fs.writeFile(join(home, 'config.v0-backup.json'), jsonText, 'utf8');
      }
      if (envText !== null) {
        await fs.writeFile(join(home, 'config.v0-backup.env'), envText, 'utf8');
      }
      await atomicWriteJson(jsonPath, config);
    }

    const validation = parseConfig(config);
    if (!validation.ok) {
      throw new Error(`migrated config failed validation:\n  ${validation.issues.map((i) => `${i.path}: ${i.message}`).join('\n  ')}`);
    }
    return { config: validation.value, path: jsonPath, migration: report, warnings: validation.warnings };
  }

  // Already v1 — validate.
  const validation = parseConfig(jsonValue);
  if (!validation.ok) {
    throw new Error(`invalid config at ${jsonPath}:\n  ${validation.issues.map((i) => `${i.path}: ${i.message}`).join('\n  ')}`);
  }
  return { config: validation.value, path: jsonPath, warnings: validation.warnings };
}

async function readIfExists(path: string): Promise<string | null> {
  try { return await fs.readFile(path, 'utf8'); }
  catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, path);
}
