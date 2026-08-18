# KERNEL.md — tlive frozen surface (v2)

> ⚠️ tlive 2.x 是**厂商中立、自托管的 hook 监看/审批层 + web 终端**(从 v1.0 的
> Agent-SDK 桥转向,详见 `docs/changelog-archive.md`)。下面列出的接口是 CONTRACTS,由
> `tests/contract/` 锁定。改动任一接口 = breaking change = bump major。
>
> **默认姿态 `notify`**:只监看 / 通知,shim 把每个 `PermissionRequest` 短路成
> `{}`,tlive 物理上不 hold 任何审批。下文"审批"一节描述的 gating 在
> **`mode: full`**(远程审批 opt-in)及 **`mode: all`**(连子代理也 hold 住)
> 下发生;`mode: off` 则每个 hook 都 no-op。mode 语义见 `README.md`,由
> `normalizer.ts` 的 `effectiveMode` 单点决定(notify 默认)。
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

**审批(Claude Code)**(下述主会话 gating 在 `mode: full`/`all` 下发生;
默认 `notify` 下 shim 把 `PermissionRequest` 短路成 `{}`,以下一律不发生)。
**带 `agent_id` 的子代理请求默认透传**(→`{}`,交 CC 原生;被 hold 的子代理
没有并行本地框可兜底)——只有 `mode: all` 才 hold 住等远程答(第四档,取代
已删除的 `approvals.holdSubagents`);`safe`/`trust` 的自动放行在此闸之前,
不受影响。gating 走 `PermissionRequest` hook
——它与本地权限对话**并行**(先答先得),窗口默认顶格(`approvals.windowSec`,默认 86200s
≈24h,clamp 60~86200,**两家共用**;hooks.json `timeout: 86400`,shim
IPC=窗+100s,daemon clamp 24h。超时 ≠ 拒绝——本地框永不超时仍在等,短窗口
只是逼用户回电脑,恰是 tlive 要消灭的失效模式);本地答掉后 daemon 靠 PostToolUse(同 key+tool,本地点了允许)/
UserPromptSubmit(同 key)/ Stop(同 key)cancel 挂起请求(resolve 为
'local',wire 上映射回 'defer' → shim 输出 `{}` pass-through)。
PermissionDenied(同 key+tool)只覆盖规则型拒绝——真机实测:用户在对话框点
"No" **不会** fire 它,本地拒绝靠 UserPromptSubmit/Stop 扫尾(最晚 turn 结束
时释放)。`notification` 的 `permission_prompt` 类型由 shim **打标透传**,发不发
由 daemon 判:`full` 模式下**永不**推 IM 文本 —— 走到那里说明 tlive 看过这个
请求并主动放手了(子代理透传 / policy 放行 / 无答复面),而"放手"的定义就是
"表现得像没装 tlive",裸推一条你答不了的"去终端答"是基线里不存在的消息;况且
它无法归属(CC 的 Notification 输入既无 `agent_id` 也无 `tool_name`)。`notify`
模式下 tlive 同样**不推 IM 文本**,但理由不同:那个框只有终端答得了,而手机
够不着终端,所以那条消息在收件人那儿没有出口——投递规则是"只送到你能做点
什么的面上"。该模式的信号走桌面提醒 + dashboard 只读卡(都是 tlive 自己的
界面,不是 CC 的输出),IM 侧只在**每个 chat 第一次**发一张说明卡告诉你为什么
安静、并给一个切到 `full` 的按钮(受 `/mute` 约束;被静音时不消耗那一次机会)。

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

- **spawn custody**(`spawn.ts`):一个**永不放弃的健康循环**,只问一个问题
  ——「control socket 上有没有 app-server 在监听」。有就什么都不做,没有就
  spawn 一个;`hasCodex()` 为假时保持安静但**继续查**。Codex TUI 启动时
  **自行**连上那个 socket(Codex 自身特性,tlive 不逐会话配置)。
  **为什么是「有没有在监听」而不是「我们的子进程还活着吗」**:实例是共享的,
  可能来自上一个 daemon、来自 `codex app-server daemon start`、也可能来自我们。
  只监管自己的子进程会让 **adopt 来的实例完全无人看管** —— 它一死就再也回不来,
  而 `tlive status` 照样说 running(状态来自「我们调过 spawn」,不来自任何应答)。
  自从重启改成永远 adopt 而不是替换,**那就是每一次重启**。
  **也没有放弃这一说**:旧逻辑连续 6 次快速退出后就不再排定时器,而那正是
  卸载 codex 的形状 —— 二进制离开 PATH、每次 respawn 立刻 ENOENT、不到一分钟
  烧完预算,**把 codex 装回来也没用,必须手动重启 daemon**。现在失败只会
  拉长 backoff 和改变上报状态。真机验证:`kill -9` 掉 app-server,不碰 daemon,
  约 15 秒后自己回来。
  **那个实例是共享的,所以 tlive 不拥有它的生命周期**:`appServerSpawnOptions`
  用 `detached: true`(+`unref`),`custody.stop()` **只停监管、不杀进程**。
  以前它是 daemon 的子进程且 stop 时被 `kill()` ⇒ 每次 `tlive stop/start`
  都换一个空实例,当时挂在旧实例上的 TUI 变成孤儿:registry 里没有该会话、
  无监看无审批无通知,而 `tlive status` 仍说 companion running(它确实连上了
  新实例,只是那实例里没有线程)。socket 才是会合点,所以重启后 probe 会
  **adopt 回同一个实例**,已挂上去的 TUI 全都还在。
  这与 Codex 自己的做法一致(`app-server-daemon/src/backend/pid.rs`:
  `Stdio::null()` + `pre_exec{setsid()}` + pid 文件长活)。**没有**改成直接调
  `codex app-server daemon start`:那条路要求 standalone 托管安装
  (`~/.codex/packages/standalone/current/codex`,`ensure_managed_codex_bin`),
  npm 装法上硬报错。
- **rpc**(`rpc.ts` 的 `defaultCodexSocket`):走 Codex 官方 app-server RPC,
  订阅 thread/turn 事件流。
  **`clientInfo.name` 必须是 `COMPANION_CLIENT_NAME`(upstream 豁免名单里的
  `codex_app_server_daemon`)**,不能是 `tlive`:`initialize` 会调
  `set_default_originator(clientInfo.name)`,那是**进程级全局、首次写入即锁死**
  的值(`initialize_processor.rs:112` → `login/src/auth/default_client.rs:86`),
  而 companion 永远抢在 TUI 之前连上 ⇒ 该 app-server 里此后所有线程(**包括
  用户自己在 TUI 里开的**)都被盖成我们的名字。后果有两条,都实测过:
  ① `is_first_party_originator()` 认 `codex-tui` 不认别的,而
  `core/src/mcp_skill_dependencies.rs:42` gate 在它上面 ⇒ 监看会**降级被监看的
  会话**;② rollout 头写着 `originator: tlive` 的会话其实是用户开的,这个错标签
  两次把排查带去找不存在的"自我喂养"。豁免名单是 upstream 的 const,所以不靠
  假设——`effectiveOriginator`(从 `initialize` 响应的 `userAgent` 首段解析)
  在豁免失效那天会打一行 WARNING。
  另外:握手失败时**必须关掉 socket 并且只报一次**——`onClose` 在握手成功后
  才接上。以前失败会同时走"promise reject"和"ws close"两条路各触发一次重连,
  两条重连循环各连一次 ⇒ daemon 对同一个 app-server 握着**两条**连接,
  两边都装着 handler ⇒ 每个事件处理两遍、每条命令发两次审批。
- **companion**(`companion.ts` 的 `startCompanion`):把 RPC 事件接进
  daemon 的会话模型(`threadKey` 做 codex thread → tlive session 的映射),
  Codex 发起权限请求时以 `ServerRequest` 广播给 IM/web **和**原生 TUI 提示
  ——**先答先得**,与 Claude Code 并行通道同一语义。没有窗口可配置:原生
  提示永远不会被 tlive 卡住,因此没有超时概念。
- **turn 结局判定**(`companion.ts` 的 `resolveOutcome`,纯函数):
  app-server 把"turn 死了"和"为什么死"分在**两个**通知里,只有一个带得动原因:
  `TurnComplete` + 有记录的错误 → `turn.status = "failed"` 且 `turn.error` 有值
  (`bespoke_event_handling.rs:1478`);`TurnAborted` → `status = "interrupted"`
  且 **`error: None` 是硬编码的**(:1497)。**Codex 把认证失败走的是后者** ——
  所以只读 `status` 的话,"用户按了 Esc"和"API key 是死的"长得一模一样
  (rollout 里那句 `turn_aborted reason: "interrupted"` 也是这么来的)。
  ⇒ 另一半信号来自 `error` 通知(`ErrorNotification{error,willRetry,threadId,
  turnId}`):`willRetry: false` 才记(:920,`affects_turn_status()` 把过的),
  `willRetry: true` 是 `StreamError` 的**每次重试**都发一条(:937,401 那次
  一分钟 17 条),一律丢弃。判定 = interrupted + 记到错误 ⇒ **failed**;
  interrupted 且没错误 ⇒ 真的是人按的。`status` 说 failed/completed 时以它为准,
  我们只补它结构上说不出的原因;没有 `turn` 字段则当正常完成——沉默不许造出失败。
  失败走 IM(`⚠️ Codex turn failed: …`,不进桌面、不发续跑卡、**不等 grace**,
  与 CC 工具失败同规则),被打断则**哪儿都不说**。
- **发现盲区自愈(2026-07-21 源码+二进制实锤)**:活线程首 turn 未落盘时
  `thread/resume` 报 "no rollout"(app-server 对**已加载**线程也强制读
  rollout store,`resume_running_thread` → `read_stored_thread_for_resume?`,
  thread_processor.rs)——这是 codex 侧结构,tlive 只能重试。但 app-server
  会把**仍挂起的审批 ServerRequest 重发给新订阅的连接**
  (`replay_requests_to_connection_for_thread`,outgoing_message.rs,resume
  活线程路径调用;特征串在装机 0.144.4 二进制命中)——所以盲区内错过的
  审批不是永久丢失:下一个发现轮询(5s)订阅成功后会补送,卡照发。
  rollout 在**首条用户消息**时物化,而审批只可能发生在首条消息之后的 turn
  里 ⟹ 实际盲区上界 ≈ 一个轮询周期。
- **三个状态都不是终点(win32 除外)**:`off` = codex 不在 PATH 上(**稳定且正确**
  的状态,不是故障 —— 大多数用户永远不会装 Codex,把它叫 degraded 等于告诉他们
  出问题了);`degraded` = codex 在但 socket 上没人应答;`running` = 有人应答。
  三者都在同一个循环里,所以**装上 codex 不需要重启 tlive**。win32 是唯一
  `return null` 的分支 —— 那儿 `codex app-server` 压根没接好,没有会变的状态。
  companion **只在第一次 `running` 时启动**:它的全部工作就是握一条 RPC 连接,
  在没有 app-server 时启动它 = 每 30 秒记一条失败的无尽重连,而 custody 不再
  因为缺 codex 而早退之后,那会落到每一台没装 Codex 的机器上。
- **降级语义**:companion 连不上(未装 Codex、socket 上没人应答、
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

### 5. CLI subcommand surface

File: `src/kernel/contracts/cli-surface.ts`

```
核心 8:      setup, start, stop, status, logs, run, url, hook
加法命令:    mode (off|notify|full|all 姿态,持久化到 config)
             mute, trust, safe (on|off 运行时开关,与 IM 命令同一 setter)
```

核心 8 是原始冻结面;`mode` 与 3 个运行时开关是后加的(仍由
`tests/contract/cli-surface.test.ts` 锁定整份清单)。加 CLI 命令 = 先开
issue 讨论 + 更新契约测试。

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
