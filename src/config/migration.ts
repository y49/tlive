// src/config/migration.ts
//
// v0.x → v1.0 config migration (spec §14.2).
//
// Heuristics:
//   - v0.x config lives at `~/.tlive/config.env` (KEY=VALUE lines), and uses
//     envvar-style keys (`TL_TG_BOT_TOKEN`, etc). We read it and synthesize
//     a v1.0 config.json with one default workspace (cwd) + any channel
//     configs found.
//   - A JSON config whose `version` is absent or doesn't equal "1" is also
//     considered v0.x and rewritten in place; the original is backed up at
//     `~/.tlive/config.v0-backup.json`.
//   - Deprecated sections (PTY settings, web-terminal, hook-bridge) are
//     silently dropped with a migration-report warning the caller can log.
//
// The migrator is pure: it takes input text + cwd-hint and returns the new
// TliveConfigV1 + a report. I/O is the caller's concern (loader.ts).

import type {
  TliveConfigV1, WorkspaceConfigEntry, TelegramChannelConfig, FeishuChannelConfig,
} from './schema.js';

export interface MigrationReport {
  /** Fields that were dropped because they have no v1 analog. */
  dropped: string[];
  /** Warnings — ambiguous or best-guess mappings. */
  warnings: string[];
  /** Was this actually a v0.x input (migration occurred)? */
  migrated: boolean;
}

export interface MigrationInput {
  /** Raw text of `~/.tlive/config.env`, if present. */
  envText?: string;
  /** Parsed JSON of `~/.tlive/config.json`, if present. */
  jsonValue?: unknown;
  /** Default workdir for the synthesized workspace. */
  defaultWorkdir: string;
  /** Name for the synthesized workspace. Defaults to basename(workdir). */
  defaultWorkspaceName?: string;
}

/** Parse KEY=VALUE envtext (same semantics as scripts/cli.js `loadConfigEnv`). */
export function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const raw = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const key = raw.slice(0, eq).trim();
    let val = raw.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

/**
 * Detect whether the caller's inputs represent a v0.x config. Rules:
 *   - If `jsonValue` exists and has `version: "1"` → NOT v0.x (caller should
 *     skip migration and validate directly).
 *   - Otherwise (jsonValue absent, or present without correct version) → v0.x.
 *     This covers the common case of an existing `config.env` with no JSON.
 */
export function isLegacyConfig(input: MigrationInput): boolean {
  if (input.jsonValue && typeof input.jsonValue === 'object') {
    const v = (input.jsonValue as Record<string, unknown>).version;
    return v !== '1';
  }
  return true;
}

/** Produce a v1.0 config from v0.x inputs. Pure; no side effects. */
export function migrateToV1(input: MigrationInput): { config: TliveConfigV1; report: MigrationReport } {
  const env = input.envText ? parseEnvText(input.envText) : {};
  const legacy = (input.jsonValue ?? {}) as Record<string, unknown>;
  const report: MigrationReport = { dropped: [], warnings: [], migrated: true };

  // `??` fall-through isn't enough here: legacy env files commonly have
  // `TL_DEFAULT_WORKDIR=` (empty string) when the v0.x setup wizard skipped
  // it. Treat empty strings as missing so we reach `input.defaultWorkdir`
  // (the caller-provided cwd) rather than synthesizing a bad workspace.
  const envWorkdir = (env.TL_DEFAULT_WORKDIR ?? '').trim();
  const legacyWorkdir = typeof legacy.defaultWorkdir === 'string' ? legacy.defaultWorkdir.trim() : '';
  const resolvedWorkdir = envWorkdir || legacyWorkdir || input.defaultWorkdir;
  const workspace: WorkspaceConfigEntry = {
    name: input.defaultWorkspaceName ?? resolvedWorkdir.split('/').pop() ?? 'workspace',
    workdir: resolvedWorkdir,
    defaults: {
      provider: normalizeProvider(env.TL_RUNTIME ?? (legacy.runtime as string)),
    },
  };

  const channels: NonNullable<TliveConfigV1['channels']> = {};
  const tg = extractTelegram(env, legacy);
  if (tg) channels.telegram = tg;
  const fs = extractFeishu(env, legacy);
  if (fs) channels.feishu = fs;

  // Drop known deprecated sections + record them. `discord` is dropped here
  // (rather than migrated) because v1.0 removes Discord platform support
  // entirely; legacy configs with a `discord:` block continue to load with
  // a one-line warn rather than crashing schema validation.
  const DROPPED_SECTIONS = [
    'pty', 'webTerminal', 'web_terminal', 'hooks', 'hookBridge', 'hook_bridge',
    'terminalRelay', 'terminal_relay', 'scanner', 'discord',
  ];
  for (const key of DROPPED_SECTIONS) {
    if (key in legacy) report.dropped.push(key);
  }
  // Legacy env-only fields that no longer apply (Discord env keys included
  // here so old config.env files don't surface as "unknown" warnings).
  const DROPPED_ENV = [
    'TL_PTY_SHELL', 'TL_WEB_PORT', 'TL_HOOK_URL',
    'TL_DC_BOT_TOKEN', 'TL_DC_CHANNEL_ID', 'TL_DC_APP_ID',
  ];
  for (const k of DROPPED_ENV) {
    if (k in env) report.dropped.push(`env.${k}`);
  }

  // Unknown IM-transport-like env keys we did not migrate
  const KNOWN_ENV = new Set([
    'TL_TOKEN', 'TL_DEFAULT_WORKDIR', 'TL_RUNTIME',
    'TL_TG_BOT_TOKEN', 'TL_TG_CHAT_ID',
    'TL_FS_APP_ID', 'TL_FS_APP_SECRET',
    'TL_PROXY', 'HTTPS_PROXY',
    ...DROPPED_ENV,
  ]);
  for (const k of Object.keys(env)) {
    if (!KNOWN_ENV.has(k)) report.warnings.push(`env.${k} not mapped (left in config.v0-backup.json)`);
  }

  const out: TliveConfigV1 = {
    version: '1',
    daemon: {},
    workspaces: [workspace],
  };
  if (Object.keys(channels).length > 0) out.channels = channels;

  return { config: out, report };
}

function normalizeProvider(raw: unknown): 'claude' | 'codex' {
  if (typeof raw === 'string' && raw.toLowerCase() === 'codex') return 'codex';
  return 'claude';
}

function extractTelegram(env: Record<string, string>, legacy: Record<string, unknown>): TelegramChannelConfig | null {
  const token = env.TL_TG_BOT_TOKEN ?? readNested(legacy, ['telegram', 'token']);
  if (typeof token !== 'string' || token.length === 0) return null;
  const chatId = env.TL_TG_CHAT_ID ?? readNested(legacy, ['telegram', 'chatId']);
  return { token, chatId: typeof chatId === 'string' && chatId.length > 0 ? chatId : undefined };
}

function extractFeishu(env: Record<string, string>, legacy: Record<string, unknown>): FeishuChannelConfig | null {
  const appId = env.TL_FS_APP_ID ?? readNested(legacy, ['feishu', 'appId']);
  const appSecret = env.TL_FS_APP_SECRET ?? readNested(legacy, ['feishu', 'appSecret']);
  if (typeof appId !== 'string' || typeof appSecret !== 'string') return null;
  if (appId.length === 0 || appSecret.length === 0) return null;
  return { appId, appSecret };
}

function readNested(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
