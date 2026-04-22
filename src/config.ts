import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TLiveConfig {
  token: string;
  defaultWorkdir?: string;
  runtime: 'claude' | 'codex';
  telegram?: { token: string; chatId: string };
  discord?: { token: string; channelId: string };
  feishu?: { appId: string; appSecret: string };
  proxy?: string;
}

const DEFAULTS: TLiveConfig = {
  token: '',
  runtime: 'claude',
};

export function loadConfig(envPath?: string): TLiveConfig {
  const configPath = envPath ?? join(homedir(), '.tlive', 'config.env');
  const env = { ...process.env };

  if (existsSync(configPath)) {
    const lines = readFileSync(configPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!(key in env)) env[key] = val;
    }
  }

  const runtime = (env.TL_RUNTIME as 'claude' | 'codex') ?? DEFAULTS.runtime;

  return {
    token: env.TL_TOKEN ?? DEFAULTS.token,
    defaultWorkdir: env.TL_DEFAULT_WORKDIR,
    runtime: runtime === 'codex' ? 'codex' : 'claude',
    telegram: env.TL_TG_BOT_TOKEN
      ? { token: env.TL_TG_BOT_TOKEN, chatId: env.TL_TG_CHAT_ID ?? '' }
      : undefined,
    discord: env.TL_DC_BOT_TOKEN
      ? { token: env.TL_DC_BOT_TOKEN, channelId: env.TL_DC_CHANNEL_ID ?? '' }
      : undefined,
    feishu: env.TL_FS_APP_ID
      ? { appId: env.TL_FS_APP_ID, appSecret: env.TL_FS_APP_SECRET ?? '' }
      : undefined,
    proxy: env.TL_PROXY || env.HTTPS_PROXY || undefined,
  };
}
