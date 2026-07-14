// src/kernel/config/loader.ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AdapterCreds {
  telegram?: { token: string; chatIdAllowList?: string[] };
  feishu?: { appId: string; appSecret: string; chatId?: string };
}
export interface WebConfig {
  enabled?: boolean;
  bind?: string;
  port?: number;
  /** Externally reachable base URL (e.g. tailscale/reverse-proxy). When set,
   *  IM approval/continue messages carry a deep link to the web dashboard. */
  publicUrl?: string;
}
export interface PolicyConfig { autoAllow?: string[]; autoDeny?: string[]; ask?: string[] }

/** Remote-approval window (seconds), claude-only — the PermissionRequest hook
 *  runs PARALLEL to the local dialog, so a long window is cheap. Default 1800
 *  (30min), clamped to 86200 (~24h). Codex hooks are retired; Codex approvals
 *  go through the app-server companion instead, which has no window concept
 *  (the native prompt is never blocked). */
export interface ApprovalsConfig { claudeWindowSec?: number }

export interface KernelConfig {
  allowedSenders: Array<{ channel: 'telegram' | 'feishu'; userId: string }>;
  adapters: AdapterCreds;
  web?: WebConfig;
  policy?: PolicyConfig;
  approvals?: ApprovalsConfig;
  daemon?: { socketPath?: string; healthPort?: number; autoStart?: boolean };
}

const DEFAULT: KernelConfig = { allowedSenders: [], adapters: {} };

export function loadConfig(home: string): KernelConfig {
  const p = join(home, 'config.json');
  if (!existsSync(p)) return { ...DEFAULT };
  const raw = JSON.parse(readFileSync(p, 'utf-8'));
  return { ...DEFAULT, ...raw };
}
