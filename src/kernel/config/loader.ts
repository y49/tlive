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
}
export interface PolicyConfig { autoAllow?: string[]; autoDeny?: string[]; ask?: string[] }

/** Remote-approval window (seconds), claude-only — the PermissionRequest hook
 *  runs PARALLEL to the local dialog, so a long window is cheap. Default 1800
 *  (30min), clamped to 86200 (~24h). Codex hooks are retired; Codex approvals
 *  go through the app-server companion instead, which has no window concept
 *  (the native prompt is never blocked). */
/** continueWindowSec: how long the async Stop hook waits in the background for
 *  a reply-to-continue (default 1800 = 30min; the hook is async so this never
 *  blocks the local terminal). continueGraceSec: after a turn ends, wait this
 *  long before pushing a continue card — if you start a new prompt within it
 *  (you're at the keyboard) the card is suppressed (default 15s).
 *  approvalGraceSec: 收到审批请求后先静默这么久再推 IM 卡 —— 你在键盘前
 *  答掉了(PostToolUse → cancel)卡就永不发出(默认 10s;0 = 立即发)。
 *  与 continueGraceSec 对称。web 广播不受影响。 */
export interface ApprovalsConfig { claudeWindowSec?: number; continueWindowSec?: number; continueGraceSec?: number; approvalGraceSec?: number }

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
  const cfg: KernelConfig = { ...DEFAULT, ...raw };
  // Allowlist `web` fields explicitly — a blind spread would let a stray
  // `publicUrl` (retired deep-link token) survive into the loaded config.
  if (raw.web) cfg.web = { enabled: raw.web.enabled, bind: raw.web.bind, port: raw.web.port };
  return cfg;
}
