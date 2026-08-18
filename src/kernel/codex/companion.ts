// src/kernel/codex/companion.ts
//
// Codex app-server 陪跑模块:连上后订阅所有线程(list+resume,含 no-rollout
// 重试)、把 commandExecution 审批转发给 PermissionRouter(超时取自
// deps.windowSec(),与 CC 共用 approvals.windowSec,默认 86200s 顶格,
// 本地答案通过 item/completed / turn/completed 释放挂起卡)、requestUserInput
// 只广播 attention 不代答(留给原生终端)。掉线自动重连(1s..30s 退避),纯编排
// 层不直接碰 ws/net —— 一切通过注入的 connect。
import { COMPANION_CLIENT_NAME, type CodexRpc, type CodexRpcEvents } from './rpc.js';
import type { PermissionRouter } from '../daemon/permission-router.js';
import { TURN_FINISHED_SENTINEL, type MonitorEvent } from '../hook/normalizer.js';

/** How a turn ended, resolved from the two signals the app-server splits it
 *  across (see resolveOutcome). `interrupted` means the human hit Esc;
 *  `failed` means something went wrong and nobody has been told yet. */
export type TurnOutcome = 'completed' | 'interrupted' | 'failed';

/** Same cap the Claude Code tool-failure path uses (normalizer.ts) — a failure
 *  report is one line in a chat, not a log dump. */
const ERROR_TEXT_MAX = 200;

/** What tlive may do with an app-server approval request, mapped from the
 *  posture ladder. Codex used to ignore the ladder entirely — the shim was the
 *  only thing consulting it — so approvals were held and carded in EVERY
 *  posture, including `off`, which is documented as a kill switch. */
export type ApprovalPolicy =
  /** `off`: behave as if tlive were not installed. */
  | 'ignore'
  /** `notify`: point at the terminal, hold nothing, answer nothing. */
  | 'notify'
  /** `full` / `all`: hold it and offer a remote answer. */
  | 'hold';

export interface CompanionDeps {
  connect: (events: CodexRpcEvents) => Promise<CodexRpc>;
  permissionRouter: Pick<PermissionRouter, 'requestPermission' | 'cancel'>;
  onMonitor: (ev: MonitorEvent, key: string) => void;
  onResumePrompt: (p: { threadId: string; key: string; lastMessage?: string; outcome: TurnOutcome; errorMessage?: string }) => void;
  /** 远程审批窗口(秒),与 CC 共用 approvals.windowSec —— 消除"一家可配一家硬编码"的不对称。 */
  windowSec: () => number;
  /** Read per request, never cached: `tlive mode …` and IM's `/mode` must
   *  change the NEXT approval without a restart, exactly as the shim re-reads
   *  it on every hook. Absent = 'hold', which is the behaviour every caller had
   *  before the ladder reached this path. */
  approvalPolicy?: () => ApprovalPolicy;
  /** `notify` posture: a native prompt is waiting at the terminal. Same
   *  surfaces the Claude Code path uses for this — the machine and the
   *  dashboard, never IM, because a phone cannot answer a terminal dialog. */
  onNativePrompt?: (p: { key: string; cwd: string; detail: string }) => void;
  /** …and it is over, so the dashboard's read-only card cannot strand. */
  onNativePromptResolved?: (p: { key: string }) => void;
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
// Discovery poll = the upper bound on the "approval fired before we
// subscribed" blind window. Keep it tight: thread/loaded/list is a local
// unix-socket call, and the app-server REPLAYS still-pending approval
// ServerRequests to a freshly subscribed connection
// (outgoing_message.rs replay_requests_to_connection_for_thread, called from
// the running-thread resume path; feature string verified in the installed
// 0.144.4 binary) — so an approval raised inside the window is answerable
// the moment the next poll subscribes us, not lost to native-only.
const POLL_MS = 5_000;
/** How long a subscribed thread may go silent before we let it go.
 *
 *  Deliberately long. A subscription is what stops the app-server from ever
 *  unloading a thread — it only closes one that has NO subscribers and is idle
 *  — so watching forever means every Codex session tlive has ever seen stays
 *  resident, and every approval left pending on a dead one is replayed to each
 *  new connection, notifying about a thread whose terminal is long gone.
 *
 *  The cost of letting go is a blind window: a released thread whose user
 *  comes back and finishes a turn inside one poll produces no turn-finished
 *  announcement. Thirty minutes keeps that window almost entirely on threads
 *  that are actually dead — a session in use never goes that quiet.
 *
 *  It is also exactly Codex's own number: THREAD_UNLOADING_DELAY in
 *  app-server/src/request_processors/thread_lifecycle.rs is 30 minutes of no
 *  subscribers AND inactivity before it unloads a thread. Matching it means
 *  tlive never gives up on a thread sooner than Codex would. The two clocks
 *  overlap rather than stack — the app-server takes
 *  `max(no-subscribers-since, inactive-since) + 30min` — so the worst case
 *  from last word to unloaded is about an hour, not two. */
const IDLE_RELEASE_MS = 30 * 60_000;

export function startCompanion(deps: CompanionDeps): Companion {
  let stopped = false;
  let rpc: CodexRpc | undefined;
  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const lastMessages = new Map<string, string>();
  /** threadId → the last turn-affecting error the app-server reported, kept only
   *  until the turn ends. Needed because the failure text and the fact that the
   *  turn died arrive on DIFFERENT notifications: an auth failure comes through
   *  as an abort, and `handle_turn_interrupted`
   *  (app-server/src/bespoke_event_handling.rs:1497) hardcodes `error: None`, so
   *  `turn/completed` alone can never say why. Retryable errors are excluded at
   *  the recording site — see the `error` handler. */
  const lastErrors = new Map<string, string>();
  /** Threads with an outstanding NATIVE prompt we merely pointed at. Only the
   *  `notify` posture puts anything here; it exists so the dashboard card is
   *  retired by the same events that would have released a held card. */
  const nativePrompts = new Set<string>();
  // Threads we've already (attempted to) resume on the current connection.
  // Cleared on disconnect — a reconnect doesn't preserve app-server subscriptions.
  let resumed = new Set<string>();
  /** Approvals still waiting for an answer on the CURRENT connection. The
   *  requester of a Codex approval is that connection, so when it drops the
   *  request is gone with it — the thread that raised it died too. Without
   *  this the card sat there for the rest of the approval window, up to 24h,
   *  offering a decision that would be written to a closed socket. Same shape
   *  as the Claude Code path, where the IPC server ties onAbandoned to the
   *  shim's connection. */
  let abandonOnDisconnect = new Set<() => void>();
  /** threadId → 该 thread 的真实工作目录。来自 thread/resume 响应的 cwd
   *  (ThreadResumeResponse.cwd,见 app-server-protocol .../v2/thread.rs)。
   *  key 仍是 codex:<threadId>(唯一),cwd 才是真目录 —— registry 据此把
   *  label 算成 basename(cwd) = 项目名,与 CC 一致。
   *  时序保证:resume 成功才订阅、订阅了才有事件 ⟹ cwd 一定先于事件到手
   *  (registry 的 cwd 首次创建后不可变,所以这点很关键)。 */
  const threadCwds = new Map<string, string>();
  /** threadId → last time this thread said anything on the current connection.
   *  Absence means "subscribed but nothing heard yet"; the value is seeded at
   *  resume so a thread that never speaks still ages out. */
  const lastHeard = new Map<string, number>();
  /** threadId → the `updatedAt` we last observed for a thread we have RELEASED.
   *  Presence in this map is what "released, watching from outside" means, and
   *  the stored value is the baseline that decides whether it has stirred. */
  const released = new Map<string, number>();
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
        const cwd = (res as { cwd?: unknown } | undefined)?.cwd;
        if (typeof cwd === 'string' && cwd) threadCwds.set(threadId, cwd);
        released.delete(threadId);
        // Seeded, not left absent: a thread that is resumed and then never
        // speaks must still age out, or the silent ones would be exactly the
        // ones we keep forever.
        if (!lastHeard.has(threadId)) lastHeard.set(threadId, Date.now());
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

  /** Let a silent thread go, so the app-server can unload it and cancel
   *  whatever it still has pending. Failure is not worth reporting: the next
   *  sweep tries again, and a thread that has already gone is the outcome we
   *  wanted. */
  function releaseThread(threadId: string): void {
    if (!rpc) return;
    resumed.delete(threadId);
    lastHeard.delete(threadId);
    released.set(threadId, 0);
    rpc.call('thread/unsubscribe', { threadId }).catch(() => undefined);
  }

  /** Has a RELEASED thread stirred? Answered with `thread/read`, which reads
   *  state without subscribing — that is the whole reason letting go is safe.
   *  Resubscribing on mere presence in `thread/loaded/list` instead would flap
   *  every poll, since a thread whose own terminal is still attached stays
   *  loaded no matter what we do. */
  async function stirredSinceRelease(threadId: string): Promise<boolean> {
    if (!rpc) return false;
    try {
      const res = (await rpc.call('thread/read', { threadId })) as { thread?: { updatedAt?: unknown; status?: { type?: unknown } } } | undefined;
      const t = res?.thread ?? {};
      if (t.status?.type === 'active') return true;
      const updatedAt = typeof t.updatedAt === 'number' ? t.updatedAt : 0;
      const baseline = released.get(threadId) ?? 0;
      if (baseline === 0) { released.set(threadId, updatedAt); return false; }
      return updatedAt > baseline;
    } catch {
      return false;
    }
  }

  async function pollThreads(): Promise<void> {
    if (stopped || !rpc) return;
    try {
      const res = (await rpc.call('thread/loaded/list', {})) as { data?: string[] } | undefined;
      const ids = res?.data ?? [];
      const now = Date.now();
      for (const [id, heard] of lastHeard) {
        if (now - heard >= IDLE_RELEASE_MS) releaseThread(id);
      }
      for (const id of ids) {
        if (released.has(id)) {
          if (await stirredSinceRelease(id)) resumeThread(id);
          continue;
        }
        resumeThread(id);
      }
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
    // We identify as a non-originating client precisely so that watching the
    // user's Codex cannot change it (see COMPANION_CLIENT_NAME). That exemption
    // lives in an upstream allowlist we do not control, so verify it instead of
    // assuming it: if our name comes back as the process originator, every
    // thread in this app-server — the user's own TUI threads included — is now
    // labelled as us, and `is_first_party_originator` has started rejecting
    // them.
    if (rpc.effectiveOriginator && rpc.effectiveOriginator === COMPANION_CLIENT_NAME) {
      log(`companion: WARNING app-server originator is now '${rpc.effectiveOriginator}' — this client is no longer exempt, the user's own Codex sessions are being relabelled`);
    }
    await pollThreads();
    startPolling();
  }

  function retireNativePrompt(threadId: string): void {
    if (nativePrompts.delete(threadId)) deps.onNativePromptResolved?.({ key: threadKey(threadId) });
  }

  function handleNotify(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    // Any word from a thread is proof it is alive; that is the whole input to
    // the release decision below.
    const heardFrom = (p.threadId as string | undefined) ?? readThreadId(p);
    if (heardFrom) lastHeard.set(heardFrom, Date.now());
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
      // A new turn owns its own verdict: a stale error would make the next
      // turn's clean interrupt read as a failure.
      lastErrors.delete(threadId);
      const key = threadKey(threadId);
      deps.onMonitor({ event: 'activity', cwd: cwdOf(threadId), sessionId: threadId, toolName: '(turn)', result: {} }, key);
      return;
    }
    if (method === 'error') {
      // ErrorNotification { error: TurnError, willRetry, threadId, turnId }
      // (app-server-protocol .../v2/notification.rs:41). `willRetry` splits two
      // very different events that share one method: StreamError, emitted once
      // PER RETRY while the app-server keeps trying (:937), and a real
      // turn-affecting failure (:920, gated on `affects_turn_status()`). Only
      // the latter is news — a dead API key produced seventeen retry errors in
      // one minute, and reporting those is the empty-card flood wearing a
      // different hat.
      const threadId = (p.threadId as string | undefined) ?? '';
      if (!threadId || p.willRetry === true) return;
      const msg = ((p.error ?? {}) as { message?: unknown }).message;
      if (typeof msg === 'string' && msg.trim()) lastErrors.set(threadId, msg.trim().slice(0, ERROR_TEXT_MAX));
      return;
    }
    if (method === 'item/completed') {
      const threadId = (p.threadId as string | undefined) ?? '';
      const item = (p.item ?? {}) as Record<string, unknown>;
      if (threadId && item.type === 'commandExecution') {
        deps.permissionRouter.cancel({ key: threadKey(threadId), toolName: 'Bash', sessionId: threadId });
        retireNativePrompt(threadId);
      }
      if (threadId && item.type === 'agentMessage') {
        // An empty agentMessage must not clobber the previous real one — the
        // continue card's excerpt comes from here, and '' renders as a bare
        // "Reply to continue" with the actual last words lost.
        const text = (item.text as string | undefined) ?? '';
        if (text.trim()) lastMessages.set(threadId, text);
      }
      return;
    }
    if (method === 'turn/completed') {
      const threadId = (p.threadId as string | undefined) ?? '';
      if (threadId) {
        deps.permissionRouter.cancel({ key: threadKey(threadId) });
        retireNativePrompt(threadId);
        const key = threadKey(threadId);
        const lastMessage = lastMessages.get(threadId);
        const { outcome, errorMessage } = resolveOutcome(p.turn, lastErrors.get(threadId));
        lastErrors.delete(threadId);
        // The dashboard's only view of this turn. A failure says so — the
        // sentinel would claim a finished turn and offer a reply that leads
        // nowhere.
        deps.onMonitor(
          {
            event: 'attention',
            cwd: cwdOf(threadId),
            sessionId: threadId,
            message: outcome === 'failed' ? failureText(errorMessage) : TURN_FINISHED_SENTINEL,
            ...(outcome !== 'failed' && lastMessage !== undefined ? { lastMessage } : {}),
          },
          key,
        );
        deps.onResumePrompt({
          threadId,
          key,
          ...(lastMessage !== undefined ? { lastMessage } : {}),
          outcome,
          ...(errorMessage ? { errorMessage } : {}),
        });
      }
      return;
    }
    if (method === 'serverRequest/resolved') {
      // ServerRequestResolvedNotification { threadId, requestId } — the
      // app-server telling us this request is settled, whoever settled it.
      // The terminal answering used to be INFERRED from item/completed; this
      // is the event that says so, and it also fires when the app-server
      // cancels a thread's requests on shutdown.
      const threadId = (p.threadId as string | undefined) ?? '';
      if (threadId) deps.permissionRouter.cancel({ key: threadKey(threadId) });
      return;
    }
    if (method === 'thread/closed' || method === 'thread/archived') {
      // `thread/closed` is the app-server shutting an unsubscribed, idle
      // thread down — it cancels that thread's pending requests first,
      // "because they can no longer be answered". `thread/archived` is the
      // user archiving it. Both mean the same thing to us: this session is
      // over and anything still held for it is void.
      //
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
        deps.permissionRouter.cancel({ key });
        lastMessages.delete(threadId);
        lastErrors.delete(threadId);
        lastHeard.delete(threadId);
        released.delete(threadId);
        resumed.delete(threadId);
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
      const policy = deps.approvalPolicy?.() ?? 'hold';
      // Never responding is the pass-through: the app-server keeps the request
      // pending and the native prompt remains the only answer, which is exactly
      // what "as if tlive were not installed" means here.
      if (policy === 'ignore') return;
      if (policy === 'notify') {
        nativePrompts.add(threadId);
        deps.onNativePrompt?.({ key: threadKey(threadId), cwd: cwdOf(threadId), detail: describeCommand(command, reason) });
        return;
      }
      let abandon: (() => void) | undefined;
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
          onAbandoned: (cb) => { abandon = cb; abandonOnDisconnect.add(cb); },
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
        })
        .finally(() => { if (abandon) abandonOnDisconnect.delete(abandon); });
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
        lastHeard.clear();
        released.clear();
        // Before clearing: every approval still waiting on this connection has
        // lost its requester.
        for (const cb of abandonOnDisconnect) cb();
        abandonOnDisconnect = new Set();
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

/** One line, phrased like the Claude Code tool-failure report so both vendors
 *  read the same way in a chat. */
export function failureText(errorMessage?: string): string {
  return errorMessage ? `Codex turn failed: ${errorMessage}` : 'Codex turn failed (no error detail)';
}

/** Resolve how a turn ended from `turn/completed`'s payload plus any
 *  turn-affecting error recorded earlier in the same turn.
 *
 *  The app-server splits an ended turn across two shapes, and only one of them
 *  can carry a reason:
 *   - `TurnComplete` with a recorded error → `status: "failed"`, `turn.error` set
 *     (bespoke_event_handling.rs:1478).
 *   - `TurnAborted` → `status: "interrupted"`, **`error: None` unconditionally**
 *     (:1497). Codex routes authentication failures down this path, which is why
 *     a dead API key looks exactly like the user pressing Esc if you read
 *     `status` alone — and why the rollout files say
 *     `turn_aborted reason: "interrupted"` for a 401.
 *
 *  So an interrupt with a remembered error is a failure, and an interrupt
 *  without one is a human. `status` still wins whenever it says `failed` or
 *  `completed`: the app-server's own verdict is never overridden by a leftover
 *  error, we only fill in a reason it structurally cannot report. A payload
 *  with no `turn` at all is treated as a normal completion — silence must not
 *  manufacture failures. */
export function resolveOutcome(
  turn: unknown,
  recordedError?: string,
): { outcome: TurnOutcome; errorMessage?: string } {
  const t = (turn ?? {}) as { status?: unknown; error?: { message?: unknown } | null };
  const status = typeof t.status === 'string' ? t.status : undefined;
  const own = t.error?.message;
  const message = (typeof own === 'string' && own.trim() ? own.trim().slice(0, ERROR_TEXT_MAX) : undefined) ?? recordedError;
  if (status === 'failed') return { outcome: 'failed', ...(message ? { errorMessage: message } : {}) };
  if (status === 'interrupted') {
    return message ? { outcome: 'failed', errorMessage: message } : { outcome: 'interrupted' };
  }
  return { outcome: 'completed' };
}

/** One line naming what the terminal is being asked to approve. Codex hands us
 *  the real command, so unlike the Claude Code notify path this never has to
 *  guess or fall back to vendor boilerplate. */
export function describeCommand(command: unknown, reason?: unknown): string {
  const cmd = Array.isArray(command) ? command.join(' ') : typeof command === 'string' ? command : '';
  const why = typeof reason === 'string' && reason.trim() ? `${reason.trim()} — ` : '';
  return `${why}${cmd}`.trim() || 'a command needs your approval';
}

function readThreadId(p: Record<string, unknown>): string | undefined {
  const thread = p.thread as { id?: string } | undefined;
  if (thread?.id) return thread.id;
  if (typeof p.threadId === 'string') return p.threadId;
  return undefined;
}
