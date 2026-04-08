import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TLiveConfig {
  port: number;
  token: string;
  defaultProvider: 'claude' | 'codex';
  permissionTimeout: number;
  webEnabled: boolean;
  messageBatchDelay: number;
  proactiveNotifyDelay: number;
  proactiveQuestionDelay: number;
  telegram?: { token: string; chatId: string };
  discord?: { token: string; channelId: string };
  feishu?: { appId: string; appSecret: string };
  proxy?: string;
}

const DEFAULTS: TLiveConfig = {
  port: 8849,
  token: '',
  defaultProvider: 'claude',
  permissionTimeout: 55000,
  webEnabled: false,
  messageBatchDelay: 250,
  proactiveNotifyDelay: 60000,
  proactiveQuestionDelay: 5000,
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

  return {
    port: parseInt(env.TL_PORT ?? '') || DEFAULTS.port,
    token: env.TL_TOKEN ?? DEFAULTS.token,
    defaultProvider: (env.TL_DEFAULT_PROVIDER as 'claude' | 'codex') ?? DEFAULTS.defaultProvider,
    permissionTimeout: parseInt(env.TL_PERMISSION_TIMEOUT ?? '') || DEFAULTS.permissionTimeout,
    webEnabled: env.TL_WEB_ENABLED === 'true',
    messageBatchDelay: parseInt(env.TL_MESSAGE_BATCH_DELAY ?? '') || DEFAULTS.messageBatchDelay,
    proactiveNotifyDelay: parseInt(env.TL_PROACTIVE_NOTIFY_DELAY ?? '') || DEFAULTS.proactiveNotifyDelay,
    proactiveQuestionDelay: parseInt(env.TL_PROACTIVE_QUESTION_DELAY ?? '') || DEFAULTS.proactiveQuestionDelay,
    telegram: env.TL_TELEGRAM_TOKEN
      ? { token: env.TL_TELEGRAM_TOKEN, chatId: env.TL_TELEGRAM_CHAT_ID ?? '' }
      : undefined,
    discord: env.TL_DISCORD_TOKEN
      ? { token: env.TL_DISCORD_TOKEN, channelId: env.TL_DISCORD_CHANNEL_ID ?? '' }
      : undefined,
    feishu: env.TL_FEISHU_APP_ID
      ? { appId: env.TL_FEISHU_APP_ID, appSecret: env.TL_FEISHU_APP_SECRET ?? '' }
      : undefined,
    proxy: env.TL_PROXY || env.HTTPS_PROXY || undefined,
  };
}
