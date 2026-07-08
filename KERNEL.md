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
type HookEventName = 'pre-tool-use' | 'post-tool-use' | 'stop' | 'notification'
                   | 'user-prompt-submit' | 'session-start' | 'session-end';

type NormalizedHook =
  | { event: 'approval-request'; cwd; sessionId; toolName; input; permissionMode? } // PreToolUse
  | { event: 'activity';         cwd; sessionId; toolName; result }                // PostToolUse
  | { event: 'attention';        cwd; sessionId; message; lastMessage? }           // Stop / Notification
  | { event: 'prompt';           cwd; sessionId; prompt }                          // UserPromptSubmit
  | { event: 'session-start';    cwd; sessionId; source? }
  | { event: 'session-end';      cwd; sessionId; reason? };

// 监看子集(经 IPC `hook.event` 传输):
type MonitorEvent = activity | attention | prompt | session-start | session-end

type HookVendor = 'claude' | 'codex';

// decision 序列化回各 vendor 的 hook 格式(vendor 差异只在这一层收口,kernel 不感知):
permissionDecisionOut(decision: 'allow'|'deny'|'defer', vendor?: HookVendor, reason?: string): object
continueDecisionOut(reply: string | null): object   // reply → {decision:'block',reason}
```

Claude / Codex 的原始 hook JSON 在这里归一。加一个新 AI runtime = 把它的 hook
事件映射进这套归一模型,kernel 不变。

**Codex 是这套模式的实例**(`src/kernel/integrations/install-hooks.ts` 的
`installCodexHooks()` 写 `~/.codex/hooks.json`,schema 与 Claude
`settings.json` 的 `hooks` 块同构;shim 靠 `tlive hook --codex <event>` 的
`--codex` flag 选 vendor)。主要输出差异体现在 `permissionDecisionOut`(deny 带
reason、defer→ask);另有装机层(`install-hooks.ts` 的事件集,无 Notification
/SessionEnd)与超时层(`hook.ts` shim 死线兜 Codex fail-open)的差异:

- `defer`:Claude 序列化为 `{}`(空输出 → 回落本地 TUI);Codex 序列化为
  `{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask'}}`
  ——Codex 对空输出的处理是 fail-open(工具自动跑),不能复用 `{}`。
- `deny`:Codex 必须带非空 `permissionDecisionReason`(空 reason 会被 Codex
  当放行处理),tlive 未提供时自动补一个;Claude 不需要。
- Codex 没有 `Notification` / `SessionEnd` 这两个 hook 事件,
  `installCodexHooks()` 只装 `PreToolUse`(600s)/`Stop`(180s)/
  `PostToolUse`/`UserPromptSubmit`/`SessionStart`。
- Codex hook 超时默认 fail-open(命令照跑),不像 Claude 超时回落本地提示;
  shim 对审批请求自我限时 ~590s(< hooks.json 里配的 600s),抢在 Codex 的
  fail-open 前给出 allow/deny/ask 三态之一。shim 进程本身崩溃是唯一没堵上
  的口子——那种情况下 Codex 600s 后依然会 fail-open,详见 `README.md` 安全
  模型段。

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
- 加 AI runtime → 写「该 runtime 的 hook 事件 → 归一模型」的映射;Codex
  adapter(`src/kernel/hook/normalizer.ts` 的 `HookVendor`/
  `src/kernel/integrations/install-hooks.ts` 的 `installCodexHooks()`)是
  现成范例。
- 改任一契约 → breaking change,bump major + 更新 `tests/contract/`。
- 重构 kernel 内部 → 随意,只要 `tests/contract/` 保持绿。

## Architecture(给新贡献者)

```
你自己的 claude/codex ──hooks──▶ tlive hook shim ──IPC──▶ daemon
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
