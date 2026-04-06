# LiveSession Design — Long-Lived Query with Thread/Turn Model

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace per-message `query()` calls with long-lived sessions following the official SDK streaming input pattern. Introduce a `LiveSession` abstraction aligned with both Claude SDK's AsyncGenerator model and Codex's Thread/Turn/Steer model.

**Architecture:**

```
                    IM Message
                        │
                   BridgeManager
                        │
                    SDKEngine
                        │
              ┌─── SessionRegistry ───┐
              │  key: chat + workdir  │
              │  getOrCreate()        │
              │  route steer/turn     │
              └──────────┬────────────┘
                         │
                   LiveSession (interface)
                    ┌────┴────┐
             ClaudeLive    (CodexLive
              Session       future)
                │
           query() +
           AsyncGenerator
```

**Session Key:** `${channelType}:${chatId}:${workdir}` — supports:
- Different chats → different workspaces (natural isolation)
- Same chat switching workdir → multiple sessions, one active
- Future parallel workspaces → same chat, multiple active sessions

---

## Task 0: Define LiveSession Interface

**Files:**
- Modify: `bridge/src/providers/base.ts`

**Changes:**

```typescript
export interface TurnParams {
  workingDirectory: string;
  model?: string;
  permissionMode?: 'acceptEdits' | 'plan' | 'default';
  attachments?: FileAttachment[];
  onPermissionRequest?: PermissionRequestHandler;
  onAskUserQuestion?: (...) => Promise<Record<string, string>>;
  effort?: 'low' | 'medium' | 'high' | 'max';
}

export interface LiveSession {
  /** Start a new turn (user message → agent response). Returns per-turn event stream. */
  startTurn(prompt: string, params: TurnParams): StreamChatResult;
  /** Inject into active turn — like Codex turn/steer */
  steerTurn(text: string): void;
  /** Interrupt active turn */
  interruptTurn(): Promise<void>;
  /** Close session and release all resources */
  close(): void;
  /** Whether the underlying query/thread is still alive */
  readonly isAlive: boolean;
}

export interface LLMProvider {
  streamChat(params: StreamChatParams): StreamChatResult;
  capabilities(): ProviderCapabilities;
  /** Create a long-lived session. Providers that don't support this return undefined. */
  createSession?(params: { workingDirectory: string }): LiveSession;
}
```

Also add `liveSession` to `ProviderCapabilities`:
```typescript
export interface ProviderCapabilities {
  // ... existing fields
  /** Supports long-lived sessions via createSession() */
  liveSession: boolean;
}
```

Remove `MessageInjector` class — replaced by `LiveSession.steerTurn()`.

Remove `streamingInput` from `ProviderCapabilities` — replaced by `liveSession`.

Remove `messageInjector` from `StreamChatParams` — no longer needed.

**Verify:** `npm test` — tests pass (interface-only changes, existing mocks use `as any`)

---

## Task 1: Implement ClaudeLiveSession

**Files:**
- Create: `bridge/src/providers/claude-live-session.ts`
- Modify: `bridge/src/providers/claude-sdk.ts`

**Design:** ClaudeLiveSession wraps a single long-lived `query()` call with an AsyncGenerator prompt. Each `startTurn()` yields a new message into the generator and returns a ReadableStream that receives events until the next `result` message.

```typescript
// claude-live-session.ts

export class ClaudeLiveSession implements LiveSession {
  private query: Query;
  private messageQueue: Array<{ text: string; resolve: () => void }> = [];
  private waitingForMessage: ((msg: string | null) => void) | null = null;
  private currentTurnController: ReadableStreamDefaultController<CanonicalEvent> | null = null;
  private _isAlive = true;
  private adapter = new ClaudeAdapter();

  constructor(options: QueryOptions) {
    // Create AsyncGenerator that feeds the query
    const self = this;
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      while (true) {
        const msg = await self.nextMessage();
        if (msg === null) return; // session closed
        yield { type: 'user', message: { role: 'user', content: msg } };
      }
    }

    this.query = query({ prompt: prompt(), options });

    // Background consumer: routes SDK events to the active turn's controller
    this.consumeInBackground();
  }

  private async consumeInBackground(): Promise<void> {
    try {
      for await (const msg of this.query) {
        const events = this.adapter.mapMessage(msg);
        for (const event of events) {
          this.currentTurnController?.enqueue(event);
          // result event = turn complete
          if (event.kind === 'query_result') {
            this.currentTurnController?.close();
            this.currentTurnController = null;
          }
        }
      }
    } finally {
      this._isAlive = false;
      this.currentTurnController?.close();
      this.currentTurnController = null;
    }
  }

  startTurn(prompt: string, params: TurnParams): StreamChatResult {
    const stream = new ReadableStream<CanonicalEvent>({
      start: (controller) => {
        this.currentTurnController = controller;
        this.pushMessage(prompt);
      }
    });

    const controls: QueryControls = {
      interrupt: () => this.interruptTurn(),
      stopTask: (id) => (this.query as any).stopTask?.(id),
    };

    return { stream, controls };
  }

  steerTurn(text: string): void {
    // Yield another message into the generator mid-turn
    this.pushMessage(text);
  }

  async interruptTurn(): Promise<void> {
    await (this.query as any).interrupt?.();
  }

  close(): void {
    this._isAlive = false;
    // Signal generator to return
    if (this.waitingForMessage) {
      this.waitingForMessage(null);
      this.waitingForMessage = null;
    }
    (this.query as any).close?.();
  }

  get isAlive(): boolean { return this._isAlive; }

  // Internal: push message to generator
  private pushMessage(text: string): void { ... }
  // Internal: generator awaits next message
  private nextMessage(): Promise<string | null> { ... }
}
```

**ClaudeSDKProvider changes:**
- Add `createSession(params)` method that creates a `ClaudeLiveSession`
- Keep `streamChat()` for backward compat (single-shot mode)
- Update `capabilities()`: `liveSession: true`, remove `streamingInput`

**Verify:** `npm test`

---

## Task 2: Add SessionRegistry to SDKEngine

**Files:**
- Modify: `bridge/src/engine/sdk-engine.ts`

**Changes:**

Replace `activeInjectors`, `activeMessageIds`, `messageQueue` with a unified `SessionRegistry`:

```typescript
interface ManagedSession {
  session: LiveSession;
  chatKey: string;
  workdir: string;
  activeMessageId?: string;  // current working card for steer matching
  costTracker: CostTracker;
}

class SDKEngine {
  private registry = new Map<string, ManagedSession>();

  /** Session key: channelType:chatId:workdir */
  private sessionKey(channelType: string, chatId: string, workdir: string): string {
    return `${channelType}:${chatId}:${workdir}`;
  }

  private getOrCreateSession(
    channelType: string, chatId: string, workdir: string, provider: LLMProvider
  ): ManagedSession {
    const key = this.sessionKey(channelType, chatId, workdir);
    let managed = this.registry.get(key);
    if (managed && managed.session.isAlive) return managed;

    // Create new session
    const session = provider.createSession?.({ workingDirectory: workdir });
    if (!session) {
      // Fallback: no LiveSession support (Codex, etc.)
      // Use per-turn streamChat() via a shim
      ...
    }
    managed = { session, chatKey, workdir, costTracker: new CostTracker() };
    this.registry.set(key, managed);
    return managed;
  }

  /** Close session for a chat (on /new, session expiry, etc.) */
  closeSession(channelType: string, chatId: string, workdir: string): void {
    const key = this.sessionKey(channelType, chatId, workdir);
    const managed = this.registry.get(key);
    if (managed) {
      managed.session.close();
      this.registry.delete(key);
    }
  }
}
```

**handleMessage flow:**

```typescript
async handleMessage(adapter, msg, provider) {
  const workdir = session.workingDirectory;
  const managed = this.getOrCreateSession(..., workdir, provider);

  // Start new turn
  const result = managed.session.startTurn(msg.text, turnParams);
  // Consume per-turn stream with renderer (same as current processMessage)
  // On query_result → turn complete, renderer.onComplete()
  // Track managed.activeMessageId from renderer
}
```

**Steer routing (from BridgeManager):**

```typescript
// BridgeManager: when processing and reply-to matches working card
if (sdkEngine.canSteer(channelType, chatId, replyToMessageId)) {
  sdkEngine.steer(channelType, chatId, text);
}
```

**Remove:** `activeInjectors`, `activeMessageIds`, `messageQueue`, `MessageInjector` usage.
**Keep:** `activeControls` (still needed for /stop), `sessionCostTrackers` → moved into ManagedSession.

**Verify:** `npm test`

---

## Task 3: Update BridgeManager Routing

**Files:**
- Modify: `bridge/src/engine/bridge-manager.ts`

**Changes:**

Replace the `isProcessing` guard logic:

```typescript
if (this.state.isProcessing(chatKey)) {
  if (msg.text && this.sdkEngine.canSteer(msg.channelType, msg.chatId, msg.replyToMessageId)) {
    // Reply to working card → steer (inject into active turn)
    this.sdkEngine.steer(msg.channelType, msg.chatId, msg.text);
    await adapter.send({ chatId: msg.chatId, text: '💬 Message sent to active session' });
  } else if (msg.text) {
    // Direct send → queue for next turn
    this.sdkEngine.queueMessage(msg.channelType, msg.chatId, msg);
    await adapter.send({ chatId: msg.chatId, text: '📥 Queued — will process after current task' });
  }
  continue;
}
```

Also update session cleanup paths:
- `/new` command → `sdkEngine.closeSession()`
- Session expiry → `sdkEngine.closeSession()`

**Verify:** `npm test`

---

## Task 4: Update ConversationEngine for Per-Turn Streams

**Files:**
- Modify: `bridge/src/engine/conversation.ts`

**Changes:**

`processMessage()` currently calls `llm.streamChat()`. When using LiveSession, SDKEngine calls `session.startTurn()` directly and consumes the per-turn stream itself. ConversationEngine's role shifts to:
- Lock management (still needed — prevents concurrent turns on same session)
- Message persistence (save user/assistant messages)
- Stream consumption (unchanged — same ReadableStream<CanonicalEvent>)

Add a `streamResult` parameter to skip the `llm.streamChat()` call when a pre-built stream is provided:

```typescript
interface ProcessMessageParams {
  // ... existing
  /** Pre-built stream from LiveSession.startTurn() — skips llm.streamChat() */
  streamResult?: StreamChatResult;
}

// In processMessage():
const result = params.streamResult ?? llm.streamChat({ ... });
```

**Verify:** `npm test`

---

## Task 5: Cleanup and Migration

**Files:**
- Modify: `bridge/src/providers/base.ts` — remove `MessageInjector`, `messageInjector` from `StreamChatParams`
- Modify: `bridge/src/providers/claude-sdk.ts` — remove streaming input generator from `streamChat()`
- Modify: `bridge/src/engine/conversation.ts` — remove `messageInjector` from params
- Modify: `bridge/src/context.ts` — remove `MessageInjector` export
- Modify: `bridge/src/providers/codex-provider.ts` — `liveSession: false` in capabilities

**Verify:** `npm test`, `npm run build`

---

## Implementation Order

```
Task 0: LiveSession interface          ← foundation
Task 1: ClaudeLiveSession impl         ← provider layer
Task 2: SessionRegistry in SDKEngine   ← engine layer
Task 3: BridgeManager routing          ← routing layer
Task 4: ConversationEngine adaptation  ← consumption layer
Task 5: Cleanup old code               ← remove MessageInjector etc.
```

Tasks must be sequential — each depends on the previous.

## Testing Strategy

Each task must:
1. Pass existing 506 tests
2. Type check with `npx tsc --noEmit`
3. Build with `npm run build`

Task 1 should add unit tests for `ClaudeLiveSession` (turn lifecycle, steer, close).

## Codex Compatibility

Codex provider returns `createSession() → undefined` (capability `liveSession: false`). SDKEngine falls back to per-turn `streamChat()` calls, same as current behavior.

## Multi-Workspace Support

Session registry key: `channelType:chatId:workdir`
- Different chats → different keys → isolated sessions
- Same chat, `/workdir` switch → new key → new session (old session preserved, can switch back)
- Future parallel → multiple active keys per chat
