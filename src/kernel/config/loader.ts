// src/kernel/config/loader.ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ShimMode } from '../hook/normalizer.js';

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
 *  共用此值。上限 86200 给 shim IPC 的 +100s 留余量,保证
 *  窗口 < shim IPC < vendor timeout(86400)。
 *  continueWindowSec: async Stop hook 后台等续跑回复的时长(默认 1800)。
 *  continueGraceSec: turn 结束后等这么久再推续跑卡(默认 15)。
 *  approvalGraceSec: 审批卡推送前的静默期(默认 10;0=立即发)。
 *  以下三个会改变"没装 tlive 时的行为",是明确的取舍开关:
 *  autoApprove: 不写 = 关(什么都不自动放行)。一旦设置就会抹掉 CC 本该弹出
 *  的确认框 —— PermissionRequest 只在 ask 路径触发,见 policy-engine。
 *  (子代理拦不拦已并入姿态梯子:`tlive mode all`,见 kernel/config/mode.ts。)
 *  timeoutAction: 'deny' 会在窗口耗尽时替你拒绝(默认 'defer' 回落 CC 原生)。 */
export interface ApprovalsConfig { windowSec?: number; continueWindowSec?: number; continueGraceSec?: number; approvalGraceSec?: number; autoApprove?: 'readonly' | 'safe'; timeoutAction?: 'defer' | 'deny' }

export interface KernelConfig {
  allowedSenders: Array<{ channel: 'telegram' | 'feishu'; userId: string }>;
  adapters: AdapterCreds;
  web?: WebConfig;
  policy?: PolicyConfig;
  approvals?: ApprovalsConfig;
  daemon?: { socketPath?: string; healthPort?: number; autoStart?: boolean };
  /** 姿态梯子:off | notify | full | all,见 kernel/config/mode.ts。
   *  缺省时按 'notify' 处理(见 hook.ts readMode / effectiveMode)。 */
  mode?: ShimMode;
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
