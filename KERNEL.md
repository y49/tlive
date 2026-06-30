# KERNEL.md — tlive frozen surface (v2.0)

> ⚠️ tlive 2.0 是**厂商中立、自托管的 hook 审批/监看层**(从 v1.0 的 Agent-SDK
> 桥转向,详见 `CHANGELOG.md`)。下面列出的接口是 CONTRACTS,由 `tests/contract/`
> 锁定。改动任一接口 = breaking change = bump major。
>
> v1.0 的 SDK-driver 冻结面(`RuntimeAdapter` / `RuntimeEvent` / MCP 三工具 /
> `mcp` 与 `handoff` 命令)已在 v2.0 移除——tlive 不再驱动/拥有会话。

## What "frozen" means

下面的 surface 是契约,`tests/contract/` 锁死它们。内部实现(kernel 类、adapter
逻辑、IM 卡片渲染、CLI 内部 dispatch)可以自由改,只要契约测试保持绿。

## The frozen surfaces

### 1. `IMAdapter` interface

File: `src/kernel/contracts/im-adapter.ts`

```typescript
export type IMChannel = 'telegram' | 'feishu';

export interface IMAdapter {
  readonly channel: IMChannel;
  start(): Promise<void>;          // idempotent; binds long-poll/WS/webhook
  stop(): Promise<void>;            // MUST release every ref'd handle (zombie fix)
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
  text: string; replyToMessageId?: string; ts: number;
}

type OutgoingMessage =
  | { kind: 'text'; text: string }
  | { kind: 'card'; title?: string; body: string; buttons?: Array<{id: string; label: string}> };
```

IM 平台特有字段(用户名、表情、附件)在 adapter 边界丢弃。

### 3. Hook 归一事件模型

File: `src/kernel/hook/normalizer.ts`

```typescript
type HookEventName = 'pre-tool-use' | 'post-tool-use' | 'stop' | 'notification';

type NormalizedHook =
  | { event: 'approval-request'; cwd; sessionId; toolName; input }   // PreToolUse
  | { event: 'activity';         cwd; sessionId; toolName; result }  // PostToolUse
  | { event: 'attention';        cwd; sessionId; message };          // Stop / Notification

// decision 序列化回 Claude hook 格式:
permissionDecisionOut(decision: 'allow' | 'deny' | 'defer'): object  // defer = {} = 回落本地 TUI
continueDecisionOut(reply: string | null): object                    // reply → {decision:'block',reason}
```

Claude / Codex 的原始 hook JSON 在这里归一。加一个新 AI runtime = 把它的 hook
事件映射进这套归一模型,kernel 不变。

### 4. IPC 协议(`hook.*`)

File: `src/kernel/ipc/protocol.ts`

消息族(shim ↔ daemon):`hook.permission.request` / `.answer`、
`hook.continue.request` / `.answer`、`hook.notify`;结果:
`hook.permission.result`(`allow | deny | defer`)、`hook.continue.result`。
传输跨平台(POSIX unix socket / Windows 命名管道)。

### 5. CLI subcommand surface (13)

File: `src/kernel/contracts/cli-surface.ts`

```
start, stop, restart, status, doctor, daemon-logs,    # daemon 生命周期
workspace,                                             # workspace 管理
setup, install-integrations,                           # 向导
hook,                                                  # Claude hook shim
approve,                                               # CLI 兜底审批
version, update                                        # meta
```

加 CLI 命令 = 加一个 metadata 操作 = 先开 issue 讨论。

## Contributing

- 加 IM 平台 → 写新 `IMAdapter` plugin,别动 kernel。
- 加 AI runtime → 写「该 runtime 的 hook 事件 → 归一模型」的映射。
- 改任一契约 → breaking change,bump major + 更新 `tests/contract/`。
- 重构 kernel 内部 → 随意,只要 `tests/contract/` 保持绿。

## Architecture(给新贡献者)

```
┌─ IM Adapters (Telegram / 飞书) ─────────┐
│  Kernel (workspace / ipc / permission /   │ ← frozen surface
│  hook normalizer / CLI dispatch)          │
└─ 你自己的 `claude` / `codex` 会话 ────────┘
   (hooks 装在 ~/.claude/settings.json)
```

- `daemon` 常驻你的开发机,跑 IPC server + IM adapter。
- 你自己交互式 `claude`/`codex` 的 hook → `tlive hook` shim → IPC → daemon →
  撮合(`PermissionRouter` / `ContinueBroker`)→ IM。
- **不再有 SDK 驱动 / MCP / 会话所有权**:tlive 不拥有会话,只观察 + 审批 + 通知。
