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

/** windowSec: 远程审批窗口(秒)。默认 86200(≈24h,clamp 上限)—— CC 的
 *  PermissionRequest hook 与本地对话框并行,不阻塞终端,长窗零成本;窗口越短
 *  你越可能被迫回电脑,而"不必回电脑"正是 tlive 的全部价值。两家(CC/Codex)
 *  共用此值。desktopNotify: 审批卡发出时在 daemon 本机弹一条桌面通知
 *  (Linux notify-send),指向手机卡/dashboard —— 补后台命令 hook 挂起期间
 *  CC 不渲染本地框的缺口(默认 true;非 Linux 或无 notify-send 静默降级)。
 *  上限 86200 给 shim IPC 的 +100s 留余量,保证
 *  窗口 < shim IPC < vendor timeout(86400)。
 *  continueWindowSec: async Stop hook 后台等续跑回复的时长(默认 1800)。
 *  continueGraceSec: turn 结束后等这么久再推续跑卡(默认 15)。
 *  approvalGraceSec: 审批卡推送前的静默期(默认 10;0=立即发)。 */
export interface ApprovalsConfig { windowSec?: number; continueWindowSec?: number; continueGraceSec?: number; approvalGraceSec?: number; desktopNotify?: boolean; autoApprove?: 'readonly' | 'safe'; holdSubagents?: boolean }

export interface KernelConfig {
  allowedSenders: Array<{ channel: 'telegram' | 'feishu'; userId: string }>;
  adapters: AdapterCreds;
  web?: WebConfig;
  policy?: PolicyConfig;
  approvals?: ApprovalsConfig;
  daemon?: { socketPath?: string; healthPort?: number; autoStart?: boolean };
  /** tlive 姿态:'full' = 远程审批 + 监看(卖点全开);'notify' = 只监看/通知,
   *  绝不 gating 任何审批(shim 默认,安全);'off' = 全关 kill switch。
   *  缺省时 shim 按 'notify' 处理(见 hook.ts readMode)。 */
  mode?: 'off' | 'notify' | 'full';
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
