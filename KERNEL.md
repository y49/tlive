# KERNEL.md — tlive frozen surface (v2)

> ⚠️ tlive 2.x 是**厂商中立、自托管的 hook 审批/监看层 + web 终端**(从 v1.0 的
> Agent-SDK 桥转向,详见 `CHANGELOG.md`)。下面列出的接口是 CONTRACTS,由
> `tests/contract/` 锁定。改动任一接口 = breaking change = bump major。
>
> v1.0 的 SDK-driver 冻结面(`RuntimeAdapter` / MCP 三工具等)已在 v2 移除——
> tlive 不再驱动/拥有会话。

## What "frozen" means

下面的 surface 是契约,`tests/contract/` 锁死它们。内部实现(kernel 类、adapter
逻辑、web UI、卡片渲染、CLI 内部 dispatch)可以自由改,只要契约测试保持绿。

## The frozen surfaces

### 1. `IMAdapter` interface

File: `src/kernel/contracts/im-adapter.ts`

```typescript
export type IMChannel = 'telegram' | 'feishu';

export interface IMAdapter {
  readonly channel: IMChannel;
  start(): Promise<void>;          // idempotent; binds long-poll/WS/webhook
  stop(): Promise<void>;            // MUST release every ref'd handle
  send(out: OutgoingMessage): Promise<{ messageId: string }>;
  edit(messageId: string, out: OutgoingMessage): Promise<void>;
  onInbound(handler: (env: IncomingEnvelope) => void): void;
  isConnected(): 'connected' | 'idle' | 'failed';
}
```

加一个 IM 平台 = 在 `src/adapters/im/` 写一个新的 `IMAdapter` plugin。别动 kernel。

### 2. `IncomingEnvelope` + `OutgoingMessage`

File: `src/kernel/contracts/im-adapter.ts`

```typescript
interface IncomingEnvelope {
  channel: IMChannel; chatId: string; userId: string; messageId: string;
  text: string;
  replyToMessageId?: string;   // quote-reply routing (→ session injection)
  attachments?: Array<{ name: string; mime: string; localPath: string; sizeBytes: number }>;
  ts: number;
}

type OutgoingMessage =
  | { kind: 'text'; text: string }
  | { kind: 'card'; title?: string; body: string; buttons?: Array<{id: string; label: string}> };
```

附件由 adapter **先下载到 `~/.tlive/inbox`** 再投递——kernel 只见本地路径。
其余 IM 平台特有字段(用户名、表情)在 adapter 边界丢弃。

### 3. Hook 归一事件模型

File: `src/kernel/hook/normalizer.ts`

```typescript
type HookEventName = 'permission-request' | 'permission-denied'
                   | 'post-tool-use' | 'stop' | 'notification'
                   | 'user-prompt-submit' | 'session-start' | 'session-end'
                   | 'post-tool-use-failure' | 'stop-failure'
                   | 'subagent-start' | 'subagent-stop';

type NormalizedHook =
  | { event: 'approval-request'; cwd; sessionId; toolName; input; permissionMode?; agentId? } // PermissionRequest(两家)
  | { event: 'activity';         cwd; sessionId; toolName; result }                // PostToolUse
  | { event: 'attention';        cwd; sessionId; message; lastMessage? }           // Stop / Notification
  | { event: 'prompt';           cwd; sessionId; prompt }                          // UserPromptSubmit
  | { event: 'subagent';         cwd; sessionId; delta; agentType? }               // SubagentStart/Stop
  | { event: 'permission-denied'; cwd; sessionId; toolName }                       // PermissionDenied (CC)
  | { event: 'session-start';    cwd; sessionId; source? }
  | { event: 'session-end';      cwd; sessionId; reason? };
  // post-tool-use-failure / stop-failure 归一为 attention(❌ 前缀消息),
  // 与 Stop/Notification 共用同一 MonitorEvent 变体,kernel 不额外建模。

// 监看子集(经 IPC `hook.event` 传输):
type MonitorEvent = activity | attention | prompt | subagent | permission-denied
                  | session-start | session-end

type HookVendor = 'claude' | 'codex';  // codex 值仅用于 shim 的优雅短路分支,不再驱动任何 gating 逻辑

// decision 序列化回 Claude Code 的 hook 格式(Codex 不再走 hook,故此层现在是 claude-only):
permissionRequestDecisionOut(decision: 'allow'|'deny'|'defer', reason?: string): object  // PermissionRequest wire;deny 恒带 message,defer → {}
continueDecisionOut(reply: string | null): object   // reply → {decision:'block',reason}
```

Claude 的原始 hook JSON 在这里归一。加一个新 AI runtime = 把它的 hook 事件
映射进这套归一模型(hook 式集成)或走 companion 式集成(见下),kernel 不变。

**审批(Claude Code)**:gating 走 `PermissionRequest` hook——它与本地权限
对话**并行**(先答先得),窗口默认顶格(`approvals.windowSec`,默认 86200s
≈24h,clamp 60~86200,**两家共用**;hooks.json `timeout: 86400`,shim
IPC=窗+100s,daemon clamp 24h。超时 ≠ 拒绝——本地框永不超时仍在等,短窗口
只是逼用户回电脑,恰是 tlive 要消灭的失效模式);本地答掉后 daemon 靠 PostToolUse(同 key+tool,本地点了允许)/
UserPromptSubmit(同 key)/ Stop(同 key)cancel 挂起请求(resolve 为
'local',wire 上映射回 'defer' → shim 输出 `{}` pass-through)。
PermissionDenied(同 key+tool)只覆盖规则型拒绝——真机实测:用户在对话框点
"No" **不会** fire 它,本地拒绝靠 UserPromptSubmit/Stop 扫尾(最晚 turn 结束
时释放)。`notification` 的 `permission_prompt` 类型在 CC shim 直接丢弃
(并行卡已覆盖那个时刻,再发提醒就是每张卡都重复一条)。

**`AskUserQuestion` (Claude Code only — Codex has no equivalent concept).**
CC fires a `PermissionRequest` for its own question tool, same as any other
tool. Replying `decision.behavior='deny'` + `message` makes CC **skip its
built-in question prompt** and feed `message` into the agent's conversation
stream instead — this is the *only* channel for a remote answer, since the
wire carries nothing richer than allow/deny/defer (no way to say "pick
option N" directly).

Verified live (claude 2.1.210, hook-only, isolated environment):
- while the hook is pending, the **local question prompt renders in
  parallel** — first answer wins, same as every other approval
- answering locally fires `PostToolUse(tool=AskUserQuestion)`, and the
  existing cancel machinery withdraws the remote card through the normal
  path
- **a `deny` that arrives after the local answer is completely ignored** —
  tlive never overrides a choice already made at the keyboard

The agent only ever sees `Error: <message>`, so the message has to prove
itself as an answer, not a failure: a source line, `Selected: <choice>`,
and a synthesized `AskUserQuestionOutput` JSON blob (`ask-renderer.ts`'s
`buildAskAnswerMessage`). **Wording is the single point of failure in this
whole mechanism** — change it and you must re-verify on real hardware,
because a weak phrasing reads as noise and the agent re-asks the question.

`Skip` = `allow` = pass-through. For `AskUserQuestion` specifically, `allow`
just means "run the tool" — i.e. render the question prompt — and that tool
has no other side effect, so `allow` is equivalent to handing the question
back to the local keyboard. It is **not** an auto-approval of anything the
agent does next.

- ⚠ **历史教训(2026-07-10)**:codex 0.142→0.144 把 gating 从 PreToolUse
  挪到 PermissionRequest,`PreToolUse` 开始拒收 `ask`/裸 `allow` 且对非法
  输出 **fail-open**(output_parser.rs 有测试名就叫
  `unsupported_permission_decision_fails_open`)。凡 vendor hook 语义,版本
  升级时必须回源码复核,不能假设两家或两版同构 —— 这条教训是 Codex hooks
  被彻底退役、换成 companion 架构(下方)的直接背景之一。
- PreToolUse gating(`permissionDecisionOut` / `pre-tool-use` 事件)已整体
  删除(no-compat);shim 收到未知事件一律优雅输出 `{}`。

**Hook 失败语义(CC,实测 claude 2.1.210/2.1.212)**:hook `exit 1` + 空
stdout = **fail-safe** —— CC 干净地回落本地对话框,绝不放行(隔离探针:hook
配 `exit 1` → 触发写文件命令 → 证据文件未创建 + 本地框正常弹出)。
⚠ 但"daemon 死了"**不等于**"shim exit 1"——2026-07-17 真机证伪:shim 的
`request()` 只监听 `'error'`,daemon 优雅关闭发 FIN 走 `'close'`,promise
永不 settle,shim 连同 CC 一起僵死满整个 24h 窗(后台子 agent 冻死 3h+)。
修复(`ipc/client.ts`:settled 守卫 + `'close'` reject + 清 timer)后,
daemon 死 → shim ~56ms 退出、stdout `{}`(无决策,非放行)→ CC 回落本地框,
fail-safe 才真正成立。**凡"进程消失时的行为",必须对每条 socket 生命周期
路径('error'/'close'/FIN)分别验证,不能拿一个探针的结论套另一个场景。**

**调用方死亡的判据(零误判)**:IPC `sock.on('close')` fire 时该连接的
pending **还在** = shim 异常死亡(`Decision='gone'`,卡改写 `Session
ended`,不产生任何 wire 输出)。正常流程下 shim 拿到决策才关连接,那时
pending 已被 `answer()`/`cancel()` 删掉。不需要超时/探活/心跳。已知残余
盲区:CC 死但 shim 被 systemd 收养、socket 仍连着 —— daemon 无从感知,
兜底靠 stale 点击告知。

**key 与 cwd 是两个概念,别搅在一起**:

```
key   = 会话唯一 id  (CC: session_id / Codex: codex:<threadId> / wrapped: TLIVE_SESSION uuid)
cwd   = 真实工作目录  (registry 字段;首次创建后不可变)
label = basename(cwd) → 项目名
```

曾经两边各犯一半:Codex 把唯一 id 当 cwd 用(label 显示 `codex:abc123`);
CC hook-only 把 cwd 当唯一 id 用(同目录两会话共享一条 registry 记录,
continueId 互相覆盖)。PermissionRouter/registry 现在显式带 key+cwd 两字段,
由类型系统强制分离——重新合并会编译失败,不只是测试变红。

**Codex 集成:app-server companion,不是 hook**(`src/kernel/codex/`)。
Codex 的 hooks/trust 整套已退役(no-compat,2026-07-14)——`tlive hook
--codex <event>` 现在是纯短路:立即输出 `{}` 并在 stderr 打一行 `codex
hooks are retired; tlive integrates via app-server`,不再触碰任何决策逻辑。
真正的集成路径:

- **spawn custody**(`spawn.ts` 的 `codexAppServerSockPath` + adopt-or-spawn
  逻辑):daemon 探测 tlive 的 unix socket 路径上是否已有 `codex app-server
  --listen unix://…` 在监听——有就 adopt,没有就 spawn 并托管,带
  respawn/backoff。Codex TUI 启动时**自行**连上那个 socket(Codex 自身特性,
  tlive 不逐会话配置)。
- **rpc**(`rpc.ts` 的 `defaultCodexSocket`):走 Codex 官方 app-server RPC,
  订阅 thread/turn 事件流。
- **companion**(`companion.ts` 的 `startCompanion`):把 RPC 事件接进
  daemon 的会话模型(`threadKey` 做 codex thread → tlive session 的映射),
  Codex 发起权限请求时以 `ServerRequest` 广播给 IM/web **和**原生 TUI 提示
  ——**先答先得**,与 Claude Code 并行通道同一语义。没有窗口可配置:原生
  提示永远不会被 tlive 卡住,因此没有超时概念。
- **降级语义**:companion 连不上(未装 Codex、respawn 耗尽 backoff、
  win32 尚未接好)时,`tlive status` 报告 `codex: app-server companion
  unreachable — approvals local-only`,Codex 照常走自己的本地审批流——
  无 IM/web 卡,不崩,只是少了远程通道。

**装机层**:`tlive setup` / `--hooks-only` 不手改 `~/.claude/settings.json`
/ `~/.codex/hooks.json`,而是调用各家自己的插件管理器(`claude plugin
marketplace add` + `claude plugin install tlive@tlive`;`codex plugin
marketplace add` + `codex plugin add tlive@tlive`,见
`src/kernel/integrations/plugin-install.ts`)。Claude 插件
(`plugins/claude/plugins/tlive/`)打包 hooks.json + skill;Codex 插件
(`plugins/codex/plugins/tlive/`)只打包 skill——没有 hooks 目录,没有信任
步骤。老 vendor 无插件 CLI 时退回 `docs/manual-hooks.md` 里的手动配置。
旧版本直写在磁盘上留下的条目由插件首次安装成功时剥离
(`src/kernel/integrations/hooks-cleanup.ts`),防止双发。

### 4. IPC 协议

File: `src/kernel/ipc/protocol.ts`

消息族(shim / `tlive run` ↔ daemon):

- 审批:`hook.permission.request` → `hook.permission.result`(`allow|deny|defer`);
  `hook.permission.answer`
- 续跑:`hook.continue.request` → `hook.continue.result`;
- 监看:`hook.event`(载荷 = `MonitorEvent`)、`hook.notify`
- wrapped 会话:`session.register` / `session.unregister` / `session.list`
- daemon:`daemon.status` / `daemon.stop`

传输跨平台:POSIX unix socket / **Windows 命名管道**(daemon 与 per-session
端点均有平台分支,见 `src/kernel/ipc/client.ts` 的 `defaultSocketPath` /
`sessionSocketPath`)。

**单例语义**:daemon 启动前先探活主 socket(probe-before-unlink)——已有活
daemon 时新实例打印一行提示并 `exit 0`,绝不 unlink/抢占活 socket(`src/kernel/ipc/server.ts`
的 `AlreadyRunningError`)。这是 `SessionStart` 懒启动(见 `README.md`)并发
安全的基础:多个会话同时触发懒启动时,只有一个真正落地。

### 5. CLI subcommand surface (8)

File: `src/kernel/contracts/cli-surface.ts`

```
setup, start, stop, status, logs, run, url, hook
```

加 CLI 命令 = 先开 issue 讨论。

## NOT frozen(内部实现,可自由演进)

- **web 层**(`src/kernel/web/`):stream-protocol 帧格式、`/ws/term`、
  `/ws/events` 的 `EventFrame`/`EventAction`、`/api/*`——前后端同仓同发布,
  无外部消费者。
- PolicyEngine 决策细节、审批卡渲染、SessionRegistry 模型、dashboard/terminal UI。

## Contributing

- 加 IM 平台 → 写新 `IMAdapter` plugin,别动 kernel。
- 加 AI runtime → 两条路都行:有 hook 机制就走「该 runtime 的 hook 事件 →
  归一模型」映射(参考 `src/kernel/hook/normalizer.ts`);没有 hook 但有
  RPC/server 协议就走 companion 式集成(参考 `src/kernel/codex/` 的
  spawn custody + rpc + companion 三件套)。
- 改任一契约 → breaking change,bump major + 更新 `tests/contract/`。
- 重构 kernel 内部 → 随意,只要 `tests/contract/` 保持绿。

## Architecture(给新贡献者)

```
你自己的 claude ────────── hooks ──▶ tlive hook shim ──IPC──▶ daemon
你自己的 codex ─────────── rpc ───▶ tlive app-server companion ──▶ daemon
tlive run <cmd>(前台拥有 pty)── per-session socket ──▶ PtyBridge
                                                       daemon ──▶ IM adapters(Telegram/飞书)
                                                       daemon ──▶ web(token 门):dashboard + /s/<id>
```

- daemon 常驻你的开发机:IPC server + IM adapters + web server + SessionRegistry。
- 审批:hook → `PermissionRouter`(PolicyEngine 先决;卡片发 IM + web)→ 任一端
  回答;超时 defer 回落本地。**安全默认:绝不 auto-deny;无人应答 = 本地提示。**
- 续跑:Stop hook → `ContinueBroker` → IM 回复 / web reply → 注回 hook。
- 注入:IM 引用回复 / 附件 / web 上传 → daemon 以无尺寸客户端连 per-session
  socket → bracketed paste 写入 pty。
- **tlive 不拥有会话**:`tlive run` 退出即杀 pty;daemon 只 fan-out。
```
