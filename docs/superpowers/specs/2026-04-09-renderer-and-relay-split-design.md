# Renderer Pattern + Terminal-Relay Split Design

> Branch: `feat/v1.0-architecture`
> Date: 2026-04-09
> Status: Approved

## Problem

Two architectural issues in the v1.0 bridge layer:

1. **No platform-specific rendering** — `terminal-relay.ts` uses `text.includes('Permission')` to guess notification types and inline-builds feishu headers. The `OutboundMessage` type is a "god object" mixing fields for all platforms.
2. **`terminal-relay.ts` has 5 responsibilities** (473 lines) — IPC server, web terminal, notification dispatch, reply interception, session registry — violating single responsibility.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Renderer organization | Class per platform | Each platform's rendering grows complex (Feishu Card 2.0, Telegram HTML, Discord embeds); class provides encapsulation and 1:1 adapter correspondence |
| Message types | Platform-specific (`TelegramOutbound`, `DiscordOutbound`, `FeishuOutbound`) | Type safety at adapter boundary; open-source project demands clean interfaces |
| terminal-relay split | 5 modules + thin assembly | Each module has one clear purpose, testable independently |
| IPC protocol | Structured semantic events | Renderer needs semantic data, not pre-formatted text; eliminates `text.includes()` guessing |
| MessageRenderer | State accumulator producing `ProgressSnapshot` | Platform-agnostic state management shouldn't be duplicated per platform |
| Dual notification paths | Converge at Renderer layer | SDK engine and terminal relay both need platform-specific formatting |

## 1. NotificationEvent — Structured IPC Protocol

Terminal side extracts semantic events from scanner data. No formatting, no text assembly.

```ts
type NotificationEvent =
  | { kind: 'permission_request'; toolName: string; toolInput: string; permissionId: string; expiresInMinutes?: number }
  | { kind: 'ask_user_question'; question: string; header?: string; options?: Option[]; toolUseId: string }
  | { kind: 'session_complete'; summary: string; cost?: UsageStats }
  | { kind: 'error'; message: string }
  | { kind: 'todo_update'; items: TodoItem[] }
  | { kind: 'activity_text'; text: string }
  | { kind: 'activity_tool'; toolName: string; toolInput?: string }
  | { kind: 'thinking'; active: boolean }
```

IPC wire format changes from `{ type: 'notification', payload: { text, buttons } }` to `{ type: 'notification', payload: NotificationEvent }`.

## 2. Platform-Specific Outbound Types

Replace the `OutboundMessage` god object with typed per-platform messages:

```ts
interface TelegramOutbound {
  html: string;
  buttons?: Button[];
}

interface DiscordOutbound {
  embed: DiscordEmbed;
  buttons?: Button[];
}

interface FeishuOutbound {
  card: string;        // Card 2.0 JSON
  buttons?: Button[];
  receiveIdType?: string;
}

type RenderedMessage = TelegramOutbound | DiscordOutbound | FeishuOutbound;
```

`chatId`, `replyToMessageId`, `threadId` are routing concerns — promoted to `send()` parameters, not part of message content.

## 3. NotificationRenderer Interface

```ts
interface NotificationRenderer<T extends RenderedMessage> {
  readonly channelType: ChannelType;
  renderNotification(event: NotificationEvent): T;
  renderProgress(snapshot: ProgressSnapshot): T;
}
```

Three implementations:

- `TelegramRenderer` — produces HTML via `markdownToTelegram()`, inline keyboards
- `DiscordRenderer` — produces rich embeds with color coding, code blocks
- `FeishuRenderer` — produces Card 2.0 JSON with typed headers, markdown elements, action buttons

Each Renderer internally dispatches by `event.kind` for optimal per-type rendering (permission cards, question option buttons, completion summaries, etc.).

## 4. BaseChannelAdapter Generics

```ts
abstract class BaseChannelAdapter<T extends RenderedMessage = RenderedMessage> {
  abstract readonly channelType: ChannelType;
  abstract send(chatId: string, message: T): Promise<SendResult>;
  abstract editMessage(chatId: string, messageId: string, message: T): Promise<void>;
  abstract consumeOne(): Promise<InboundMessage | null>;
  abstract sendTyping(chatId: string): Promise<void>;
  abstract validateConfig(): string | null;
  abstract isAuthorized(userId: string, chatId: string): boolean;
  async deleteMessage(_chatId: string, _messageId: string): Promise<void> {}
  async addReaction(_chatId: string, _messageId: string, _emoji: string): Promise<void> {}
  async removeReaction(_chatId: string, _messageId: string): Promise<void> {}
}
```

`consumeOne()` unchanged — inbound messages are already well-typed. `TargetResolver` already exists as a standalone class in `terminal-relay.ts`; it moves to its own file or stays in `notification-dispatcher.ts` — no interface changes needed.

## 5. terminal-relay.ts Split

Five modules extracted from the current 473-line monolith:

### ipc-server.ts
Unix socket server, line-delimited JSON protocol, connection lifecycle.
```ts
class IPCServer extends EventEmitter {
  constructor(socketPath: string)
  start(): void
  stop(): void
  broadcast(msg: object): void
  // Events: 'message' (payload, socket), 'connect' (socket), 'disconnect' (socket)
}
```

### session-registry.ts
Tracks active terminal sessions, auto-cleanup on socket disconnect.
```ts
class SessionRegistry {
  register(sessionId: string, socket: Socket, meta: SessionMeta): void
  unregister(sessionId: string): void
  getSession(sessionId: string): SessionEntry | undefined
  listSessions(): SessionEntry[]
  getBySocket(socket: Socket): SessionEntry[]
}
```

### web-terminal.ts
HTTP static server + WebSocket bidirectional PTY relay.
```ts
class WebTerminal {
  constructor(deps: { port: number; token: string; registry: SessionRegistry })
  start(): void
  stop(): void
  forwardPtyData(sessionId: string, data: string): void
}
```

### notification-dispatcher.ts
Receives semantic events, formats via Renderer, sends via Adapter, returns message IDs.
```ts
class NotificationDispatcher {
  constructor(deps: {
    adapters: () => BaseChannelAdapter[];
    renderers: Map<ChannelType, NotificationRenderer>;
    targetResolver: TargetResolver;
  })
  dispatch(event: NotificationEvent): Promise<Map<ChannelType, string>>
}
```

### reply-interceptor.ts
Tracks sent message IDs, matches inbound replies/callbacks, forwards to terminal via IPC.
```ts
class ReplyInterceptor {
  trackMessage(messageId: string, channelType: ChannelType): void
  interceptReply(msg: InboundMessage): boolean
  handleAskCallback(callbackData: string): boolean
  onForward: (payload: object) => void
}
```

### Assembly
`terminal-relay.ts` becomes a thin wiring layer (or merges into `main.ts`):
```
IPCServer.on('message') →
  notification      → NotificationDispatcher.dispatch()
  session_register  → SessionRegistry.register()
  session_unregister→ SessionRegistry.unregister()
  pty_data          → WebTerminal.forwardPtyData()
  config_update     → IPCServer.broadcast()
```

## 6. MessageRenderer Refactor

MessageRenderer retains all state management (tool counting, permission queue, elapsed timer, flush throttling) but stops producing formatted text.

```ts
interface ProgressSnapshot {
  phase: 'starting' | 'executing' | 'permission' | 'completed' | 'error';
  toolCounts: Map<string, number>;
  totalTools: number;
  elapsedSeconds: number;
  responseText: string;
  permissionQueue: PermissionState[];
  todoItems: TodoItem[];
  costLine?: string;
  errorMessage?: string;
}

class MessageRenderer {
  // Existing event methods unchanged:
  onToolStart(name: string): void
  onToolComplete(toolUseId: string): void
  onPermissionNeeded(...): void
  onPermissionResolved(permId?: string): void
  onTodoUpdate(todos: TodoItem[]): void
  onTextDelta(text: string): void
  onComplete(stats: UsageStats): void
  onError(error: string): void

  // New:
  snapshot(): ProgressSnapshot

  // Removed: render(), renderExecuting(), renderDone(), renderTodoProgress(),
  //          renderToolSummary(), applyPlatformLimit()
  // flushCallback signature changes from (content: string, isEdit) to (snapshot: ProgressSnapshot, isEdit)
}
```

## 7. Dual Notification Path Convergence

```
Path 1: Terminal Relay (user runs `tlive claude`)
  Scanner → NormalizedMessage → toNotificationEvent() → IPC
    → NotificationDispatcher → Renderer.renderNotification(event)
    → Adapter.send()

Path 2: SDK Engine (user messages from IM)
  SDK → MessageRenderer → snapshot()
    → Renderer.renderProgress(snapshot)
    → Adapter.send() / editMessage()
```

Both paths converge at the same `NotificationRenderer` implementations. Adding a new platform requires one Renderer class serving both paths.

## 8. Terminal-Side Changes

### messageNormalizer.ts
- Delete: `formatForIM()`, `imFormatters` registry
- Add: `toNotificationEvent(msg: NormalizedMessage): NotificationEvent | null`
- Pure semantic extraction, zero formatting

### notificationHub.ts
- Generic changes from `{ text, buttons }` to `NotificationEvent`
- Dedup/batching logic unchanged

### notificationRules.ts
- No changes — already operates on `kind` semantically

## 9. File Organization

```
bridge/src/
  channels/
    types.ts              ChannelType, InboundMessage, SendResult, Button
                          + TelegramOutbound, DiscordOutbound, FeishuOutbound
                          + RenderedMessage union
                          - OutboundMessage (removed)
    base.ts               BaseChannelAdapter<T extends RenderedMessage>
    telegram.ts           TelegramAdapter extends BaseChannelAdapter<TelegramOutbound>
    discord.ts            DiscordAdapter extends BaseChannelAdapter<DiscordOutbound>
    feishu.ts             FeishuAdapter extends BaseChannelAdapter<FeishuOutbound>

  renderers/              (new directory)
    types.ts              NotificationRenderer, NotificationEvent, ProgressSnapshot
    telegram.ts           TelegramRenderer
    discord.ts            DiscordRenderer
    feishu.ts             FeishuRenderer

  engine/
    ipc-server.ts         (extracted from terminal-relay)
    session-registry.ts   (extracted from terminal-relay)
    web-terminal.ts       (extracted from terminal-relay)
    notification-dispatcher.ts  (extracted from terminal-relay)
    reply-interceptor.ts  (extracted from terminal-relay)
    terminal-relay.ts     (thin assembly, may merge into main.ts)
    message-renderer.ts   (refactored: render→snapshot)

  formatting/             (deprecated, migrated to renderers/)

src/
  sdk/
    messageNormalizer.ts  (delete formatForIM, add toNotificationEvent)
  im/
    notificationHub.ts    (generic: NotificationEvent)
```

## 10. Migration Notes

- `OutboundMessage` type removed; all callers migrate to platform-specific types
- `formatting/` directory deprecated; `notification.ts` and `permission.ts` logic absorbed by Renderer classes
- `terminal-relay.ts` shrinks from 473 lines to ~50 lines of wiring (or zero if merged into main.ts)
- IPC protocol is internal (terminal↔bridge in same process group), no backwards compatibility needed
