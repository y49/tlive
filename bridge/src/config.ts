import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Which Claude Code filesystem settings to load in bridge mode.
 *  - 'user'    → ~/.claude/settings.json (auth, model overrides)
 *  - 'project' → .claude/settings.json + CLAUDE.md (project rules, MCP, skills)
 *  - 'local'   → .claude/settings.local.json (developer overrides)
 *  Default: ['user'] — only global auth/model config. */
export type ClaudeSettingSource = 'user' | 'project' | 'local';

export interface Config {
  port: number;
  token: string;
  publicUrl: string;
  enabledChannels: string[];
  runtime: 'claude' | 'codex' | 'auto';
  defaultWorkdir: string;
  defaultModel: string;
  coreUrl: string;
  /** Claude Code settings sources to load (default: ['user']) */
  claudeSettingSources: ClaudeSettingSource[];
  /** Global proxy URL (e.g., http://127.0.0.1:7890, socks5://127.0.0.1:1080) */
  proxy: string;
  telegram: {
    botToken: string;
    chatId: string;
    allowedUsers: string[];
    /** Require @mention in groups (default: true) */
    requireMention: boolean;
    /** Webhook URL (if set, uses webhook instead of polling) */
    webhookUrl: string;
    /** Webhook secret for verification */
    webhookSecret: string;
    /** Webhook listen port (default: 8443) */
    webhookPort: number;
    /** Disable link previews in outbound messages (default: true) */
    disableLinkPreview: boolean;
    /** HTTP/SOCKS proxy URL — overrides global TL_PROXY */
    proxy: string;
  };
  discord: {
    botToken: string;
    allowedUsers: string[];
    allowedChannels: string[];
    /** HTTP/HTTPS proxy URL — overrides global TL_PROXY (SOCKS not supported) */
    proxy: string;
  };
  feishu: {
    appId: string;
    appSecret: string;
    verificationToken: string;
    encryptKey: string;
    webhookPort: number;
    allowedUsers: string[];
  };
}

function parseList(value: string | undefined): string[] {
  if (!value || !value.trim()) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function loadEnvFile(path: string): Record<string, string> {
  try {
    const content = readFileSync(path, 'utf-8');
    const env: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Remove surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

export function maskSecret(value: string): string {
  if (!value || value.length <= 4) return '****';
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

export function loadConfig(): Config {
  // 1. Load env file
  const envFile = loadEnvFile(join(homedir(), '.tlive', 'config.env'));

  // 2. Inject non-TL_ vars into process.env so providers can access them
  //    (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY) — process.env takes precedence
  for (const [key, value] of Object.entries(envFile)) {
    if (!key.startsWith('TL_') && !(key in process.env)) {
      process.env[key] = value;
    }
  }

  // 3. Merge: env vars override env file
  const get = (key: string, defaultValue = ''): string =>
    process.env[key] ?? envFile[key] ?? defaultValue;

  const port = parseInt(get('TL_PORT', '4590'), 10);
  const globalProxy = get('TL_PROXY');

  const config: Config = {
    port,
    token: get('TL_TOKEN'),
    publicUrl: get('TL_PUBLIC_URL'),
    enabledChannels: parseList(get('TL_ENABLED_CHANNELS')),
    runtime: (get('TL_RUNTIME', 'claude') as Config['runtime']),
    claudeSettingSources: parseList(get('TL_CLAUDE_SETTINGS', 'user')) as ClaudeSettingSource[],
    proxy: globalProxy,
    defaultWorkdir: get('TL_DEFAULT_WORKDIR', process.cwd()),
    defaultModel: get('TL_DEFAULT_MODEL'),
    coreUrl: get('TL_CORE_URL', `http://localhost:${port}`),
    telegram: {
      botToken: get('TL_TG_BOT_TOKEN'),
      chatId: get('TL_TG_CHAT_ID'),
      allowedUsers: parseList(get('TL_TG_ALLOWED_USERS')),
      requireMention: get('TL_TG_REQUIRE_MENTION', 'true') !== 'false',
      webhookUrl: get('TL_TG_WEBHOOK_URL'),
      webhookSecret: get('TL_TG_WEBHOOK_SECRET'),
      webhookPort: parseInt(get('TL_TG_WEBHOOK_PORT', '8443'), 10),
      disableLinkPreview: get('TL_TG_DISABLE_LINK_PREVIEW', 'true') !== 'false',
      proxy: get('TL_TG_PROXY') || globalProxy,
    },
    discord: {
      botToken: get('TL_DC_BOT_TOKEN'),
      allowedUsers: parseList(get('TL_DC_ALLOWED_USERS')),
      allowedChannels: parseList(get('TL_DC_ALLOWED_CHANNELS')),
      proxy: get('TL_DC_PROXY') || globalProxy,
    },
    feishu: {
      appId: get('TL_FS_APP_ID'),
      appSecret: get('TL_FS_APP_SECRET'),
      verificationToken: get('TL_FS_VERIFICATION_TOKEN'),
      encryptKey: get('TL_FS_ENCRYPT_KEY'),
      webhookPort: parseInt(get('TL_FS_WEBHOOK_PORT', '9100'), 10),
      allowedUsers: parseList(get('TL_FS_ALLOWED_USERS')),
    },
  };

  // Validate required fields
  if (!config.token) {
    throw new Error('Config error: TL_TOKEN is required');
  }

  for (const channel of config.enabledChannels) {
    switch (channel) {
      case 'telegram':
        if (!config.telegram.botToken) {
          throw new Error('Config error: TL_TG_BOT_TOKEN is required (telegram is in enabled channels)');
        }
        break;
      case 'discord':
        if (!config.discord.botToken) {
          throw new Error('Config error: TL_DC_BOT_TOKEN is required (discord is in enabled channels)');
        }
        break;
      case 'feishu':
        if (!config.feishu.appId) {
          throw new Error('Config error: TL_FS_APP_ID is required (feishu is in enabled channels)');
        }
        if (!config.feishu.appSecret) {
          throw new Error('Config error: TL_FS_APP_SECRET is required (feishu is in enabled channels)');
        }
        break;
    }
  }

  return config;
}
