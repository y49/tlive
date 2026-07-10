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
  permissionDecisionOut,
  permissionRequestDecisionOut,
  continueDecisionOut,
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

const USAGE = 'Usage: tlive hook [--codex] <permission-request|permission-denied|pre-tool-use|post-tool-use|stop|notification|user-prompt-submit|session-start|session-end|post-tool-use-failure|stop-failure>\n';

/** 远程审批窗口(秒)+ 对应 shim IPC 死线(毫秒)。clamp 上限对齐插件
 *  hooks.json 的 vendor timeout(claude 86400 / codex 7320),保证
 *  vendor 超时永远在 shim IPC 之后才触发:窗口 < ipc(+100s)< vendor。 */
export function approvalWindow(
  vendor: HookVendor,
  approvals?: { claudeWindowSec?: number; codexWindowSec?: number },
): { timeoutSec: number; ipcMs: number } {
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
  const timeoutSec = vendor === 'codex'
    ? clamp(approvals?.codexWindowSec ?? 590, 60, 7200)      // 串行:默认 ~10min,上限 2h
    : clamp(approvals?.claudeWindowSec ?? 86_000, 60, 86_200); // 并行:默认 ~24h
  return { timeoutSec, ipcMs: (timeoutSec + 100) * 1000 };
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

  try {
    const raw = await readStdin();
    const n = parseHookInput(event, raw);
    // Inherited from a `tlive run` pty (like $TMUX): routes this hook's traffic
    // to that exact session card, so several wrapped sessions can share one cwd.
    const wrappedId = process.env.TLIVE_SESSION;

    if (event === 'permission-request') {
      // 双通道 gating。CC:hook 与本地对话并行(先答先得),窗口拉满 24h,
      // 本地答掉由 daemon 的 cancel 触发器(PostToolUse/UserPromptSubmit/Stop)
      // 释放本进程。Codex:hook 串行阻塞原生提示(orchestrator.rs 实证),
      // 只给中等窗;超时输出 {} → Codex 落回原生审批流(fail-safe)。
      const approvals = (() => {
        try { return loadConfig(process.env.TLIVE_HOME ?? join(homedir(), '.tlive')).approvals; } catch { return undefined; }
      })();
      const win = approvalWindow(vendor, approvals);
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
      process.stdout.write(JSON.stringify(permissionRequestDecisionOut(decision)));
      return;
    }

    if (event === 'notification' && vendor === 'claude'
        && (raw as { notification_type?: string }).notification_type === 'permission_prompt') {
      // The parallel PermissionRequest card is already live when the local
      // dialog pops — this notification would duplicate every approval card.
      process.stdout.write('{}');
      return;
    }

    if (n.event === 'approval-request') {
      const r = await request(
        {
          kind: 'hook.permission.request',
          cwd: n.cwd,
          sessionId: n.sessionId,
          toolName: n.toolName,
          input: n.input,
          permissionMode: n.permissionMode,
          ...(wrappedId ? { wrappedId } : {}),
        },
        { timeoutMs: 590_000 },
      );
      const decision = r.kind === 'hook.permission.result' ? r.decision : 'defer';
      process.stdout.write(JSON.stringify(permissionDecisionOut(decision, vendor)));
      return;
    }

    if (event === 'stop') {
      const att = n as { cwd: string; sessionId: string; message: string; lastMessage?: string };
      const r = await request(
        {
          kind: 'hook.continue.request',
          cwd: att.cwd,
          sessionId: att.sessionId,
          context: att.message,
          ...(att.lastMessage ? { lastMessage: att.lastMessage } : {}),
          ...(wrappedId ? { wrappedId } : {}),
        },
        { timeoutMs: 175_000 },
      );
      const reply = r.kind === 'hook.continue.result' ? r.reply : null;
      process.stdout.write(JSON.stringify(continueDecisionOut(reply)));
      return;
    }

    if (event === 'notification' || event === 'post-tool-use-failure' || event === 'stop-failure') {
      const att = n as { cwd: string; sessionId: string; message: string };
      const level = event === 'notification' ? 'info' : 'error';
      await request(
        { kind: 'hook.notify', cwd: att.cwd, sessionId: att.sessionId, level, message: att.message, ...(wrappedId ? { wrappedId } : {}) },
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
    // daemon 不可达/出错 → 安全默认。审批路径按 vendor 让原生工具本地问;其余空输出。
    process.stdout.write(event === 'pre-tool-use' ? JSON.stringify(permissionDecisionOut('defer', vendor)) : '{}');
  }
}
