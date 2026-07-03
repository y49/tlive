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

// decision 序列化回 Claude hook 格式:
permissionDecisionOut(decision: 'allow' | 'deny' | 'defer'): object  // defer = {} = 回落本地 TUI
continueDecisionOut(reply: string | null): object                    // reply → {decision:'block',reason}
```

Claude / Codex 的原始 hook JSON 在这里归一。加一个新 AI runtime = 把它的 hook
事件映射进这套归一模型,kernel 不变。

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

### 5. CLI subcommand surface (7)

File: `src/kernel/contracts/cli-surface.ts`

```
setup, start, stop, status, logs, run, hook
```

加 CLI 命令 = 先开 issue 讨论。

## NOT frozen(内部实现,可自由演进)

- **web 层**(`src/kernel/web/`):stream-protocol 帧格式、`/ws/term`、
  `/ws/events` 的 `EventFrame`/`EventAction`、`/api/*`——前后端同仓同发布,
  无外部消费者。
- PolicyEngine 决策细节、审批卡渲染、SessionRegistry 模型、dashboard/terminal UI。

## Contributing

- 加 IM 平台 → 写新 `IMAdapter` plugin,别动 kernel。
- 加 AI runtime → 写「该 runtime 的 hook 事件 → 归一模型」的映射。
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
