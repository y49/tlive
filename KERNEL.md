# KERNEL.md — tlive frozen surface (v1.0)

> ⚠️ **WARNING**: This file documents the frozen API surface of tlive 1.0.
> Modifying any interface listed here is a breaking change requiring a major
> version bump. See `docs/superpowers/specs/2026-05-11-tlive-kernel-redesign-design.md`
> for design rationale and the project commitment to "ship 1.0, freeze 3 months".
>
> **Freeze period: 2026-05-11 → 2026-08-11.** During this window, only bug
> fixes are accepted; no new features, no surface changes.

## What "frozen" means

The 6 surfaces below are CONTRACTS. Tests in `tests/contract/` lock them in.
Any change that breaks a contract test = explicit "breaking change" decision = bump major.

Internal implementation (kernel classes, adapter logic, MCP server transport, IM card
rendering, CLI internal dispatch) can change freely as long as contract tests stay green.

## The 6 frozen surfaces

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

Adding a new IM platform = write a new `IMAdapter` plugin in `src/adapters/im/`. Don't touch kernel.

### 2. `RuntimeAdapter` interface

File: `src/kernel/contracts/runtime-adapter.ts`

```typescript
export interface RuntimeAdapter {
  readonly provider: string;
  start(opts: {
    workspaceDir: string;
    resumeProviderSessionId?: string; // SDK's session id, NOT tlive's
    modelOpts?: Record<string, unknown>;
  }): Promise<{ providerSessionId: string }>;
  sendUser(text: string): Promise<void>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  events(): AsyncIterable<RuntimeEvent>;
  installPermissionHandler(handler: PermissionHandler): void;
}
```

Adding a new AI provider = write a new `RuntimeAdapter` plugin in `src/adapters/runtime/`. Don't touch kernel.

### 3. `IncomingEnvelope` + `OutgoingMessage`

File: `src/kernel/contracts/im-adapter.ts`

```typescript
interface IncomingEnvelope {
  channel: IMChannel;
  chatId: string;
  userId: string;
  messageId: string;
  text: string;
  replyToMessageId?: string; // optional
  ts: number;
}

type OutgoingMessage =
  | { kind: 'text'; text: string }
  | { kind: 'card'; title?: string; body: string; buttons?: Array<{id: string; label: string}> };
```

Any extra IM-specific fields (usernames, emojis, attachments) are DROPPED at the adapter boundary.

### 4. `RuntimeEvent` union (9 kinds)

File: `src/kernel/contracts/runtime-event.ts`

```typescript
type RuntimeEvent =
  | { kind: 'text_delta'; delta: string }
  | { kind: 'thinking_delta'; delta: string }
  | { kind: 'tool_use_start'; toolName: string; input: unknown; toolUseId: string }
  | { kind: 'tool_use_result'; toolUseId: string; output: unknown; isError: boolean }
  | { kind: 'permission_request'; toolName: string; input: unknown; requestId: string }
  | { kind: 'turn_start' }
  | { kind: 'turn_end'; usage?: Usage }
  | { kind: 'session_ready'; providerSessionId: string }
  | { kind: 'error'; message: string; recoverable: boolean };
```

Provider-specific events MUST collapse into these 9 kinds in the adapter. Kernel doesn't add new event kinds.

### 5. MCP tool surface (3 tools)

File: `src/kernel/contracts/mcp-tools.ts`

| Tool | Purpose |
|---|---|
| `mcp__tlive__approve` | Permission request (via `--permission-prompt-tool`); routes to bound IM chat |
| `mcp__tlive__ask` | AI asks user a question via IM; awaits text reply |
| `mcp__tlive__notify` | Fire-and-forget IM notification |

**No other MCP tools.** Wanting to add `handoff_to_im`, `switch_workspace`, etc.? STOP. Those are CLI/IM commands, not MCP tools (AI shouldn't know about driver/routing metadata).

### 6. CLI subcommand surface (14)

File: `src/kernel/contracts/cli-surface.ts`

```
start, stop, restart, status, doctor, daemon-logs,    # daemon lifecycle
handoff, approve,                                       # permission/handoff
workspace,                                              # workspace mgmt
setup, install-integrations,                            # wizards
mcp,                                                    # stdio MCP server
version, update                                         # meta
```

Adding a CLI command = adding a new metadata operation = open a discussion issue first.

## Contributing

Want to add an IM platform? → write a new `IMAdapter` plugin. Don't touch kernel.
Want to add an AI provider? → write a new `RuntimeAdapter` plugin. Don't touch kernel.
Want to add an MCP tool? → STOP. Open an issue. We froze at 3.
Want to add a CLI subcommand? → STOP. Open an issue. We froze at 14.
Want to refactor kernel internals? → fine, as long as `tests/contract/` stays green.

## Architecture (for new contributors)

```
┌─ IM Adapters (Telegram / Feishu)  ──────┐
│   Kernel (workspace / session / IPC /     │  ← frozen surface
│   permission / MCP server / CLI dispatch)│
└─ Runtime Adapters (Claude / Codex)  ────┘
```

- `daemon` runs long on user's dev machine (where AI lives)
- IM messages → `InboundHandler` → `SessionManager` → `RuntimeAdapter` → AI
- AI → MCP `approve`/`ask`/`notify` → `PermissionRouter`/`AskBroker`/`NotifyBroker` → IM
- Driver switching (handoff/takeback) is **out-of-band** (CLI + IM commands), AI never knows

See `docs/superpowers/specs/2026-05-11-tlive-kernel-redesign-design.md` for full design.
