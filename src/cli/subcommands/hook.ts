// src/cli/subcommands/hook.ts
//
// Thin shim invoked by Claude's hook system.
// Reads hook JSON from stdin, forwards to daemon via IPC, writes decision to stdout.
//
// Security default: if daemon is unreachable or no binding exists (defer),
// output {} and exit 0 → Claude falls back to local TUI permission prompt.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { request } from '../../kernel/ipc/client.js';
import {
  HOOK_EVENT_NAMES,
  parseHookInput,
  permissionRequestDecisionOut,
  sessionStartOut,
  effectiveMode,
  type HookEventName,
  type HookVendor,
  type MonitorEvent,
  type ShimMode,
} from '../../kernel/hook/normalizer.js';
import { loadConfig } from '../../kernel/config/loader.js';
import { spawnDaemonDetached } from '../../kernel/daemon/spawn.js';
import { approvalWindow } from '../../kernel/config/window.js';

/** session-start 时 daemon 不在 → 自动拉起(fire-and-forget,绝不阻塞 shim)。
 *  config daemon.autoStart !== false 才启用(默认开:装了 hooks 即想让 tlive 活着)。 */
export function maybeAutoStartDaemon(
  home: string,
  spawnFn: (home: string) => number | null = spawnDaemonDetached,
): boolean {
  try {
    const cfg = loadConfig(home);
    if (cfg.daemon?.autoStart === false) return false;
    spawnFn(home);
    return true;
  } catch {
    return false; // 任何失败都静默:本次事件丢了没关系,下次 daemon 已在
  }
}

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString('utf-8').trim();
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

// Generated from the canonical event list so it can never drift again
// (the old hand-written line had already lost subagent-start/subagent-stop).
const USAGE = `Usage: tlive hook [--codex] <${HOOK_EVENT_NAMES.join('|')}>\n`;

// 窗口计算已下沉到 config 层(三方共用,见 kernel/config/window.ts);
// 保留 re-export 以免动既有调用点。
export { approvalWindow };

/** 续跑窗口(秒):async Stop hook 在后台等回复的时长。默认 1800(30min);
 *  async 不占终端,所以窗口可以很长。clamp [30, 86400]。 */
export function continueWindow(approvals?: { continueWindowSec?: number }): number {
  return Math.min(Math.max(approvals?.continueWindowSec ?? 1800, 30), 86_400);
}

/** Mode posture gate (see ShimMode). Returns the stdout to write *and stop* for a
 *  disabled/notify short-circuit, or null to proceed with normal handling.
 *  - off    → '{}' for EVERY event: tlive does nothing (no gating, no IPC, no autostart).
 *  - notify → '{}' for permission-request ONLY: the one gating hook is silenced so
 *             tlive can never hold/block an approval (it falls through to CC-native);
 *             every monitoring/notification hook still runs.
 *  - full   → null everywhere: current behaviour (remote approval + monitoring). */
export function modeShortCircuit(mode: ShimMode, event: HookEventName): string | null {
  if (mode === 'off') return '{}';
  if (mode === 'notify' && event === 'permission-request') return '{}';
  return null;
}

/** Read the posture from config. Default 'notify' — a freshly-installed tlive
 *  observes + notifies but never intercepts a permission decision until the user
 *  opts into 'full' (via /tlive:setup or `tlive mode full`). Unreadable config or
 *  an unknown value falls back to the safe 'notify'. */
function readMode(home: string): ShimMode {
  try {
    return effectiveMode(loadConfig(home).mode);
  } catch {
    return 'notify';
  }
}

export function parseHookArgs(argv: string[]): { event?: HookEventName; vendor: HookVendor } {
  const vendor: HookVendor = argv.includes('--codex') ? 'codex' : 'claude';
  const event = argv.find((a) => !a.startsWith('--')) as HookEventName | undefined;
  return { event, vendor };
}

export async function runHook(argv: string[]): Promise<void> {
  const { event, vendor } = parseHookArgs(argv);
  if (!event) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  if (vendor === 'codex') {
    // Codex hooks are retired — the app-server companion is the sole
    // integration now. Stray old dev-build hooks.json entries land here;
    // answer gracefully instead of erroring so they don't break anything.
    process.stderr.write('codex hooks are retired; tlive integrates via app-server\n');
    process.stdout.write('{}');
    return;
  }

  // Posture gate FIRST — before reading stdin / any IPC / daemon autostart. In
  // 'notify' (default) a permission-request never reaches the hold logic below;
  // in 'off' nothing runs at all. This is why "notify mode" can't hang anything:
  // the gating hook is short-circuited to a pass-through {} before it can hold.
  const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
  const mode = readMode(home);
  const short = modeShortCircuit(mode, event);
  if (short !== null) { process.stdout.write(short); return; }

  try {
    const raw = await readStdin();
    const n = parseHookInput(event, raw);
    // Inherited from a `tlive run` pty (like $TMUX): routes this hook's traffic
    // to that exact session card, so several wrapped sessions can share one cwd.
    const wrappedId = process.env.TLIVE_SESSION;

    if (event === 'permission-request') {
      // CC hook 与本地对话并行(先答先得),窗口拉满 24h,本地答掉由 daemon 的
      // cancel 触发器(PostToolUse/UserPromptSubmit/Stop)释放本进程。
      const approvals = (() => {
        try { return loadConfig(process.env.TLIVE_HOME ?? join(homedir(), '.tlive')).approvals; } catch { return undefined; }
      })();
      const win = approvalWindow(approvals);
      const a = n as Extract<typeof n, { event: 'approval-request' }>;
      const r = await request(
        {
          kind: 'hook.permission.request',
          cwd: a.cwd,
          sessionId: a.sessionId,
          toolName: a.toolName,
          input: a.input,
          permissionMode: a.permissionMode,
          timeoutSec: win.timeoutSec,
          ...(a.agentId ? { agentId: a.agentId } : {}),
          ...(wrappedId ? { wrappedId } : {}),
        },
        { timeoutMs: win.ipcMs },
      );
      const decision = r.kind === 'hook.permission.result' ? r.decision : 'defer';
      const message = r.kind === 'hook.permission.result' ? r.message : undefined;
      const updatedInput = r.kind === 'hook.permission.result' ? r.updatedInput : undefined;
      process.stdout.write(JSON.stringify(permissionRequestDecisionOut(decision, message, updatedInput)));
      return;
    }

    if (event === 'notification' || event === 'post-tool-use-failure' || event === 'stop-failure') {
      const att = n as { cwd: string; sessionId: string; message: string; droppable?: boolean; permissionPrompt?: boolean };
      const level = event === 'notification' ? 'info' : 'error';
      // droppable(空失败,如 Bash 非零退出但 stderr 为空:grep 没命中/test
      // 判假/diff --quiet)照常发 hook.notify IPC——只透传标记,让 daemon 决定
      // 怎么处理。Fix 3b:曾经在这里提前 return 跳过整条 IPC,连 dashboard 的
      // events.broadcast 一起吞了(PostToolUse/PostToolUseFailure 互斥,dashboard
      // 没有别的途径看到这次工具活动)——落点错了,daemon 层(bootstrap.ts 的
      // hook.notify handler)现在只据 droppable 跳过 IM 发送,dashboard 广播
      // 不受影响。
      // permissionPrompt(issue #49)同一课的同一答案:shim 只透传,daemon 拿
      // pending 判重 —— full 模式已有卡就丢,没卡(notify 模式 / 立即 defer)
      // 就走本地等待通知链。曾经在这里无条件吞掉,notify 模式下权限框零通知。
      await request(
        { kind: 'hook.notify', cwd: att.cwd, sessionId: att.sessionId, level, message: att.message, ...(wrappedId ? { wrappedId } : {}), ...(att.droppable ? { droppable: true } : {}), ...(att.permissionPrompt ? { permissionPrompt: true } : {}) },
        { timeoutMs: 4_000 },
      ).catch(() => undefined);
      process.stdout.write('{}');
      return;
    }

    if (event === 'stop') {
      // async Stop hook(插件配 async:true+asyncRewake:true):CC 不等本进程,turn
      // 立即结束(键盘前零卡);本进程在后台等 daemon 的续跑回复。
      const att = n as { cwd: string; sessionId: string; message: string; lastMessage?: string; stopHookActive?: boolean };
      // 防循环:本 turn 是被上一次 stop hook 唤醒的续跑 → 不再等(否则无限续跑)。
      if (att.stopHookActive) return;
      const approvals = (() => {
        try { return loadConfig(process.env.TLIVE_HOME ?? join(homedir(), '.tlive')).approvals; } catch { return undefined; }
      })();
      const windowSec = continueWindow(approvals);
      const r = await request(
        {
          kind: 'hook.continue.request',
          cwd: att.cwd,
          sessionId: att.sessionId,
          context: att.message,
          ...(att.lastMessage ? { lastMessage: att.lastMessage } : {}),
          ...(wrappedId ? { wrappedId } : {}),
        },
        { timeoutMs: windowSec * 1000 + 10_000 },
      ).catch(() => null);
      const reply = r && r.kind === 'hook.continue.result' ? r.reply : null;
      if (reply) {
        // 续跑注入:exit 2 + reason 到 stderr → asyncRewake 唤醒会话继续。
        process.stderr.write(reply);
        process.exitCode = 2;
      }
      // 无回复 → exit 0:会话保持停止,不唤醒、不循环。
      return;
    }

    // post-tool-use / user-prompt-submit / session-start / session-end → monitoring
    await request(
      { kind: 'hook.event', event: n as MonitorEvent, ...(wrappedId ? { wrappedId } : {}) },
      { timeoutMs: 4_000 },
    ).catch(() => {
      if (event === 'session-start') {
        const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
        maybeAutoStartDaemon(home);
      }
    });
    if (event === 'session-start') {
      let configured = true;
      try {
        const cfg = loadConfig(process.env.TLIVE_HOME ?? join(homedir(), '.tlive'));
        configured = Boolean(cfg.adapters.telegram?.token || cfg.adapters.feishu?.appId);
      } catch { /* 读不了按已配置,不打扰 */ }
      process.stdout.write(sessionStartOut(vendor, configured, mode));
    } else {
      process.stdout.write('{}');
    }
  } catch {
    // daemon 不可达/出错 → 安全默认 {}:CC pass-through(本地对话在),
    // Codex 无决策 → 原生审批流。绝不 auto-allow。
    process.stdout.write('{}');
  }
}
