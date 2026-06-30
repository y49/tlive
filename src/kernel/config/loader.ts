// src/kernel/config/loader.ts

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AdapterCreds {
  telegram?: { token: string; chatIdAllowList?: string[] };
  feishu?: { appId: string; appSecret: string; chatId?: string };
}

export interface KernelConfig {
  workspaces: Record<string, string>;
  chatBindings: Record<string, string>;
  allowedSenders: Array<{ channel: 'telegram' | 'feishu'; userId: string }>;
  adapters: AdapterCreds;
  daemon?: { socketPath?: string; healthPort?: number };
}

const DEFAULT: KernelConfig = {
  workspaces: {}, chatBindings: {}, allowedSenders: [], adapters: {},
};

export function loadConfig(home: string): KernelConfig {
  const p = join(home, 'config.json');
  if (!existsSync(p)) return { ...DEFAULT };
  const raw = JSON.parse(readFileSync(p, 'utf-8'));
  return { ...DEFAULT, ...raw };
}
