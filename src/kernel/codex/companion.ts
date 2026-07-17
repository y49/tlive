// src/kernel/codex/companion.ts
//
// Codex app-server 陪跑模块:连上后订阅所有线程(list+resume,含 no-rollout
// 重试)、把 commandExecution 审批转发给 PermissionRouter(超时取自
// deps.windowSec(),与 CC 共用 approvals.windowSec,默认 86200s 顶格,
// 本地答案通过 item/completed / turn/completed 释放挂起卡)、requestUserInput
// 只广播 attention 不代答(留给原生终端)。掉线自动重连(1s..30s 退避),纯编排
// 层不直接碰 ws/net —— 一切通过注入的 connect。
import type { CodexRpc, CodexRpcEvents } from './rpc.js';
import type { PermissionRouter } from '../daemon/permission-router.js';
import { TURN_FINISHED_SENTINEL, type MonitorEvent } from '../hook/normalizer.js';

export interface CompanionDeps {
  connect: (events: CodexRpcEvents) => Promise<CodexRpc>;
  permissionRouter: Pick<PermissionRouter, 'requestPermission' | 'cancel'>;
  onMonitor: (ev: MonitorEvent, key: string) => void;
  onResumePrompt: (p: { threadId: string; key: string; lastMessage?: string }) => void;
  /** 远程审批窗口(秒),与 CC 共用 approvals.windowSec —— 消除"一家可配一家硬编码"的不对称。 */
  windowSec: () => number;
  log?: (msg: string) => void;
}

export interface Companion {
  stop(): void;
  resume(threadId: string, input: string): Promise<void>;
}

export const threadKey = (threadId: string): string => `codex:${threadId}`;

const RESUME_RETRY_MS = 3000;
const RESUME_RETRY_MAX = 10;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const POLL_MS = 15_000;

export function startCompanion(deps: CompanionDeps): Companion {
  let stopped = false;
  let rpc: CodexRpc | undefined;
  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const lastMessages = new Map<string, string>();
  // Threads we've already (attempted to) resume on the current connection.
  // Cleared on disconnect — a reconnect doesn't preserve app-server subscriptions.
  let resumed = new Set<string>();
  /** threadId → 该 thread 的真实工作目录。来自 thread/resume 响应的 cwd
   *  (ThreadResumeResponse.cwd,见 app-server-protocol .../v2/thread.rs)。
   *  key 仍是 codex:<threadId>(唯一),cwd 才是真目录 —— registry 据此把
   *  label 算成 basename(cwd) = 项目名,与 CC 一致。
   *  时序保证:resume 成功才订阅、订阅了才有事件 ⟹ cwd 一定先于事件到手
   *  (registry 的 cwd 首次创建后不可变,所以这点很关键)。 */
  const threadCwds = new Map<string, string>();
  /** 没拿到真 cwd 时退回 key —— 不崩,只是 label 退化成 codex:<id>。 */
  const cwdOf = (threadId: string): string => threadCwds.get(threadId) ?? threadKey(threadId);

  const log = deps.log ?? (() => undefined);

  function resumeThread(threadId: string, attempt = 1): void {
    if (stopped || !rpc) return;
    if (attempt === 1) {
      if (resumed.has(threadId)) return;
      resumed.add(threadId);
    }
    rpc.call('thread/resume', { threadId }).then(
      (res) => {
        reconnectDelay = RECONNECT_MIN_MS;
        const cwd = (res as { cwd?: unknown } | undefined)?.cwd;
        if (typeof cwd === 'string' && cwd) threadCwds.set(threadId, cwd);
      },
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/no rollout/i.test(msg) && attempt < RESUME_RETRY_MAX) {
          const t = setTimeout(() => resumeThread(threadId, attempt + 1), RESUME_RETRY_MS);
          t.unref?.();
        } else {
          log(`companion: resume ${threadId} failed: ${msg}`);
          // 清除 resumed 去重集，以便后续轮询周期可以重新尝试该线程
          resumed.delete(threadId);
        }
      },
    );
  }

  async function pollThreads(): Promise<void> {
    if (stopped || !rpc) return;
    try {
      const res = (await rpc.call('thread/loaded/list', {})) as { data?: string[] } | undefined;
      const ids = res?.data ?? [];
      for (const id of ids) resumeThread(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`companion: thread/loaded/list failed: ${msg}`);
    }
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }

  function startPolling(): void {
    stopPolling();
    pollTimer = setInterval(() => { void pollThreads(); }, POLL_MS);
    pollTimer.unref?.();
  }

  async function onConnected(): Promise<void> {
    if (!rpc) return;
    await pollThreads();
    startPolling();
  }

  function handleNotify(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === 'thread/started') {
      const threadId = readThreadId(p);
      if (threadId) resumeThread(threadId);
      return;
    }
    if (method === 'item/started') {
      const threadId = (p.threadId as string | undefined) ?? '';
      if (!threadId) return;
      const item = (p.item ?? {}) as Record<string, unknown>;
      const key = threadKey(threadId);
      const cwd = cwdOf(threadId);
      if (item.type === 'userMessage') {
        const content = item.content as Array<{ text?: string }> | undefined;
        const prompt = content?.[0]?.text ?? '';
        deps.onMonitor({ event: 'prompt', cwd, sessionId: threadId, prompt }, key);
      } else if (item.type === 'commandExecution') {
        deps.onMonitor({ event: 'activity', cwd, sessionId: threadId, toolName: 'Bash', result: {} }, key);
      }
      return;
    }
    if (method === 'turn/started') {
      const threadId = (p.threadId as string | undefined) ?? '';
      if (!threadId) return;
      const key = threadKey(threadId);
      deps.onMonitor({ event: 'activity', cwd: cwdOf(threadId), sessionId: threadId, toolName: '(turn)', result: {} }, key);
      return;
    }
    if (method === 'item/completed') {
      const threadId = (p.threadId as string | undefined) ?? '';
      const item = (p.item ?? {}) as Record<string, unknown>;
      if (threadId && item.type === 'commandExecution') {
        deps.permissionRouter.cancel({ key: threadKey(threadId), toolName: 'Bash', sessionId: threadId });
      }
      if (threadId && item.type === 'agentMessage') {
        lastMessages.set(threadId, (item.text as string | undefined) ?? '');
      }
      return;
    }
    if (method === 'turn/completed') {
      const threadId = (p.threadId as string | undefined) ?? '';
      if (threadId) {
        deps.permissionRouter.cancel({ key: threadKey(threadId) });
        const key = threadKey(threadId);
        const lastMessage = lastMessages.get(threadId);
        deps.onMonitor(
          { event: 'attention', cwd: cwdOf(threadId), sessionId: threadId, message: TURN_FINISHED_SENTINEL, ...(lastMessage !== undefined ? { lastMessage } : {}) },
          key,
        );
        deps.onResumePrompt({ threadId, key, ...(lastMessage !== undefined ? { lastMessage } : {}) });
      }
      return;
    }
    if (method === 'thread/archived') {
      // Real archival notification: ThreadArchivedNotification { threadId }
      // (app-server-protocol .../v2/common.rs:1323-1328, camelCase on the wire
      // per #[serde(rename_all = "camelCase")]), sent as method "thread/archived"
      // (server_notification_definitions!, common.rs:1485). NOT
      // thread/status/changed: ThreadStatus (v2/thread.rs:1131-1144) has exactly
      // four variants — notLoaded / idle / systemError / active — no `archived`
      // member exists, so that method can never carry archival.
      const threadId = (p.threadId as string | undefined) ?? '';
      if (threadId) {
        const key = threadKey(threadId);
        const cwd = cwdOf(threadId);
        lastMessages.delete(threadId);
        deps.onMonitor({ event: 'session-end', cwd, sessionId: threadId }, key);
        // Thread is done — drop the cached cwd so it can't leak into a stray
        // later event for the same (now-archived) threadId.
        threadCwds.delete(threadId);
      }
      return;
    }
  }

  function handleServerRequest(_id: number | string, method: string, params: unknown, respond: (result: unknown) => void): void {
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === 'item/commandExecution/requestApproval') {
      const threadId = (p.threadId as string | undefined) ?? '';
      const command = p.command;
      const cwd = p.cwd;
      const reason = p.reason;
      void deps.permissionRouter
        .requestPermission({
          key: threadKey(threadId),
          // Session cwd, from thread/resume (see threadCwds/cwdOf above) —
          // NOT `p.cwd` (that's the command-execution cwd, kept below in
          // `input.cwd` only). The router matches pending requests on `key`
          // only, never on `cwd` (see permission-router.ts's requestPermission
          // doc comment), so cwd here is purely a display value for the
          // registry's label = basename(cwd).
          cwd: cwdOf(threadId),
          toolName: 'Bash',
          input: { command, cwd, reason },
          timeoutSec: deps.windowSec(),
          sessionId: threadId,
        })
        .then((r) => {
          if (r.decision === 'allow') respond({ decision: 'accept' });
          else if (r.decision === 'deny') respond({ decision: 'decline' });
          // defer / local: never respond — leave pending / already settled elsewhere.
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log(`approval request failed: ${msg}`);
          // Never respond — approval stays pending, native prompt still governs.
        });
      return;
    }
    if (method === 'tool/requestUserInput') {
      const threadId = (p.threadId as string | undefined) ?? '';
      deps.onMonitor(
        { event: 'attention', cwd: cwdOf(threadId), sessionId: threadId, message: 'Codex is asking a question in the terminal' },
        threadKey(threadId),
      );
      return;
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => { void connectLoop(); }, delay);
    reconnectTimer.unref?.();
  }

  async function connectLoop(): Promise<void> {
    if (stopped) return;
    const events: CodexRpcEvents = {
      onNotify: handleNotify,
      onServerRequest: handleServerRequest,
      onClose: () => {
        rpc = undefined;
        stopPolling();
        resumed = new Set();
        if (!stopped) scheduleReconnect();
      },
    };
    try {
      rpc = await deps.connect(events);
      reconnectDelay = RECONNECT_MIN_MS;
      await onConnected();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`companion: connect failed: ${msg}`);
      scheduleReconnect();
    }
  }

  void connectLoop();

  return {
    stop(): void {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopPolling();
      rpc?.close();
      rpc = undefined;
    },
    async resume(threadId: string, input: string): Promise<void> {
      if (!rpc) throw new Error('companion: not connected');
      await rpc.call('turn/start', { threadId, input: [{ type: 'text', text: input }] });
    },
  };
}

function readThreadId(p: Record<string, unknown>): string | undefined {
  const thread = p.thread as { id?: string } | undefined;
  if (thread?.id) return thread.id;
  if (typeof p.threadId === 'string') return p.threadId;
  return undefined;
}
