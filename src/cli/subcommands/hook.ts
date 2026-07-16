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
  parseHookInput,
  permissionRequestDecisionOut,
  sessionStartOut,
  type HookEventName,
  type HookVendor,
  type MonitorEvent,
} from '../../kernel/hook/normalizer.js';
import { loadConfig } from '../../kernel/config/loader.js';
import { spawnDaemonDetached } from '../../kernel/daemon/spawn.js';

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

const USAGE = 'Usage: tlive hook [--codex] <permission-request|permission-denied|post-tool-use|stop|notification|user-prompt-submit|session-start|session-end|post-tool-use-failure|stop-failure>\n';

/** 远程审批窗口(秒)+ 对应 shim IPC 死线(毫秒)。clamp 上限对齐插件
 *  hooks.json 的 vendor timeout(claude 86400),保证 vendor 超时永远在
 *  shim IPC 之后才触发:窗口 < ipc(+100s)< vendor。claude-only —— Codex
 *  不再靠 hook 审批(app-server companion 是唯一集成方式)。 */
export function approvalWindow(
  approvals?: { claudeWindowSec?: number },
): { timeoutSec: number; ipcMs: number } {
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
  const timeoutSec = clamp(approvals?.claudeWindowSec ?? 1800, 60, 86_200); // 并行:默认 30min,可配到 ~24h
  return { timeoutSec, ipcMs: (timeoutSec + 100) * 1000 };
}

/** 续跑窗口(秒):async Stop hook 在后台等回复的时长。默认 1800(30min);
 *  async 不占终端,所以窗口可以很长。clamp [30, 86400]。 */
export function continueWindow(approvals?: { continueWindowSec?: number }): number {
  return Math.min(Math.max(approvals?.continueWindowSec ?? 1800, 30), 86_400);
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
      process.stdout.write(JSON.stringify(permissionRequestDecisionOut(decision, message)));
      return;
    }

    if (event === 'notification' && vendor === 'claude'
        && (raw as { notification_type?: string }).notification_type === 'permission_prompt') {
      // The parallel PermissionRequest card is already live when the local
      // dialog pops — this notification would duplicate every approval card.
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

    if (event === 'notification' || event === 'post-tool-use-failure' || event === 'stop-failure') {
      const att = n as { cwd: string; sessionId: string; message: string; droppable?: boolean };
      const level = event === 'notification' ? 'info' : 'error';
      // droppable(空失败,如 Bash 非零退出但 stderr 为空:grep 没命中/test
      // 判假/diff --quiet)照常发 hook.notify IPC——只透传标记,让 daemon 决定
      // 怎么处理。Fix 3b:曾经在这里提前 return 跳过整条 IPC,连 dashboard 的
      // events.broadcast 一起吞了(PostToolUse/PostToolUseFailure 互斥,dashboard
      // 没有别的途径看到这次工具活动)——落点错了,daemon 层(bootstrap.ts 的
      // hook.notify handler)现在只据 droppable 跳过 IM 发送,dashboard 广播
      // 不受影响。
      await request(
        { kind: 'hook.notify', cwd: att.cwd, sessionId: att.sessionId, level, message: att.message, ...(wrappedId ? { wrappedId } : {}), ...(att.droppable ? { droppable: true } : {}) },
        { timeoutMs: 4_000 },
      ).catch(() => undefined);
      process.stdout.write('{}');
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
      process.stdout.write(sessionStartOut(vendor, configured));
    } else {
      process.stdout.write('{}');
    }
  } catch {
    // daemon 不可达/出错 → 安全默认 {}:CC pass-through(本地对话在),
    // Codex 无决策 → 原生审批流。绝不 auto-allow。
    process.stdout.write('{}');
  }
}
