# Renderer Pattern + Terminal-Relay Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace inline platform-switching with typed per-platform Renderers, split terminal-relay.ts into focused modules, and upgrade the IPC protocol to structured semantic events.

**Architecture:** Foundation-first layered approach. New types and Renderers are added alongside existing code, then a dual-interface adapter bridge (`sendRendered`/`editRendered`) enables incremental caller migration without breaking compiles. Terminal-relay is split via extract-and-delegate. Cleanup removes old paths.

**Tech Stack:** TypeScript, vitest, Node.js (net, http, ws), grammy (Telegram), discord.js, @larksuiteoapi (Feishu)

**Spec:** `docs/superpowers/specs/2026-04-09-renderer-and-relay-split-design.md`

---

## Phase A: Foundation (additive — nothing breaks)

### Task 1: Renderer Type Foundation

**Files:**
- Create: `bridge/src/renderers/types.ts`
- Test: `bridge/src/__tests__/renderer-types.test.ts`

- [ ] **Step 1: Create the type file**

```ts
// bridge/src/renderers/types.ts

import type { ChannelType, Button } from '../channels/types.js';

// ---------------------------------------------------------------------------
// Structured notification events — IPC protocol between terminal and bridge
// ---------------------------------------------------------------------------

export interface AskOption {
  label: string;
  description?: string;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export type NotificationEvent =
  | { kind: 'permission_request'; toolName: string; toolInput: string; permissionId: string; expiresInMinutes?: number }
  | { kind: 'ask_user_question'; question: string; header?: string; options?: AskOption[]; toolUseId: string }
  | { kind: 'session_complete'; summary: string; cost?: UsageStats }
  | { kind: 'error'; message: string }
  | { kind: 'todo_update'; items: TodoItem[] }
  | { kind: 'activity_text'; text: string }
  | { kind: 'activity_tool'; toolName: string; toolInput?: string }
  | { kind: 'thinking'; active: boolean };

// ---------------------------------------------------------------------------
// Progress snapshot — produced by MessageRenderer (SDK engine path)
// ---------------------------------------------------------------------------

export interface PermissionState {
  toolName: string;
  input: string;
  permId: string;
  buttons: Array<{ label: string; callbackData: string; style: string }>;
}

export interface ProgressSnapshot {
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

// ---------------------------------------------------------------------------
// Command response data — structured input for renderCommandResponse
// ---------------------------------------------------------------------------

export interface CommandResponseData {
  title: string;
  /** Markdown body content */
  body?: string;
  /** Key-value fields (status, sessions, settings) */
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  /** Color hint: 'success' | 'warning' | 'info' | 'error' */
  color?: 'success' | 'warning' | 'info' | 'error';
  /** Action buttons */
  buttons?: Button[];
}

// ---------------------------------------------------------------------------
// Platform-specific outbound types
// ---------------------------------------------------------------------------

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: string;
}

export interface TelegramOutbound {
  html: string;
  buttons?: Button[];
}

export interface DiscordOutbound {
  embed: DiscordEmbed;
  buttons?: Button[];
}

export interface FeishuOutbound {
  /** Card 2.0 JSON string */
  card: string;
  buttons?: Button[];
}

export type RenderedMessage = TelegramOutbound | DiscordOutbound | FeishuOutbound;

// ---------------------------------------------------------------------------
// Renderer interface — one implementation per platform
// ---------------------------------------------------------------------------

export interface NotificationRenderer<T extends RenderedMessage = RenderedMessage> {
  readonly channelType: ChannelType;

  /** Render a discrete notification event (terminal relay path) */
  renderNotification(event: NotificationEvent): T;

  /** Render a live progress snapshot (SDK engine path) */
  renderProgress(snapshot: ProgressSnapshot): T;

  /** Render structured command/control output (status panels, session lists, help) */
  renderCommandResponse(data: CommandResponseData): T;

  /** Render a plain text feedback message (errors, confirmations) */
  renderSimpleText(text: string): T;
}
```

- [ ] **Step 2: Write type-level test**

```ts
// bridge/src/__tests__/renderer-types.test.ts
import { describe, it, expectTypeOf } from 'vitest';
import type {
  NotificationEvent, ProgressSnapshot, CommandResponseData,
  TelegramOutbound, DiscordOutbound, FeishuOutbound, RenderedMessage,
  NotificationRenderer,
} from '../renderers/types.js';

describe('renderer types', () => {
  it('NotificationEvent is a discriminated union on kind', () => {
    const event: NotificationEvent = { kind: 'error', message: 'fail' };
    expectTypeOf(event).toMatchTypeOf<NotificationEvent>();
  });

  it('RenderedMessage is a union of platform types', () => {
    const t: TelegramOutbound = { html: '<b>hi</b>' };
    const d: DiscordOutbound = { embed: { title: 'hi' } };
    const f: FeishuOutbound = { card: '{}' };
    expectTypeOf(t).toMatchTypeOf<RenderedMessage>();
    expectTypeOf(d).toMatchTypeOf<RenderedMessage>();
    expectTypeOf(f).toMatchTypeOf<RenderedMessage>();
  });

  it('NotificationRenderer is generic over RenderedMessage', () => {
    type TR = NotificationRenderer<TelegramOutbound>;
    expectTypeOf<TR['channelType']>().toEqualTypeOf<'telegram' | 'discord' | 'feishu'>();
  });
});
```

- [ ] **Step 3: Run test**

Run: `cd bridge && npx vitest run src/__tests__/renderer-types.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add bridge/src/renderers/types.ts bridge/src/__tests__/renderer-types.test.ts
git commit -m "feat(renderers): add type foundation — NotificationEvent, outbound types, Renderer interface"
```

---

### Task 2: Telegram Renderer

**Files:**
- Create: `bridge/src/renderers/telegram.ts`
- Test: `bridge/src/__tests__/telegram-renderer.test.ts`
- Reference: `bridge/src/formatting/notification.ts:46-63` (telegram case), `bridge/src/formatting/permission.ts:35-49` (telegram case)

- [ ] **Step 1: Write failing tests**

```ts
// bridge/src/__tests__/telegram-renderer.test.ts
import { describe, it, expect } from 'vitest';
import { TelegramRenderer } from '../renderers/telegram.js';
import type { NotificationEvent, ProgressSnapshot, CommandResponseData } from '../renderers/types.js';

describe('TelegramRenderer', () => {
  const r = new TelegramRenderer();

  describe('renderNotification', () => {
    it('permission_request: HTML with tool name and buttons', () => {
      const event: NotificationEvent = {
        kind: 'permission_request',
        toolName: 'Bash',
        toolInput: 'rm -rf /tmp/test',
        permissionId: 'perm-1',
        expiresInMinutes: 5,
      };
      const out = r.renderNotification(event);
      expect(out.html).toContain('<b>');
      expect(out.html).toContain('Permission');
      expect(out.html).toContain('<code>Bash</code>');
      expect(out.html).toContain('rm -rf /tmp/test');
      expect(out.buttons).toHaveLength(2);
      expect(out.buttons![0].callbackData).toBe('perm:allow:perm-1');
      expect(out.buttons![1].callbackData).toBe('perm:deny:perm-1');
    });

    it('ask_user_question: HTML with question and option buttons', () => {
      const event: NotificationEvent = {
        kind: 'ask_user_question',
        question: 'Which database?',
        options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
        toolUseId: 'tu-1',
      };
      const out = r.renderNotification(event);
      expect(out.html).toContain('Which database?');
      expect(out.buttons).toBeDefined();
      expect(out.buttons!.length).toBeGreaterThanOrEqual(2);
    });

    it('session_complete: HTML with summary', () => {
      const event: NotificationEvent = {
        kind: 'session_complete',
        summary: 'Fixed the auth bug',
        cost: { inputTokens: 1000, outputTokens: 500, costUsd: 0.05, durationMs: 10000 },
      };
      const out = r.renderNotification(event);
      expect(out.html).toContain('Fixed the auth bug');
      expect(out.html).toContain('$0.05');
    });

    it('error: HTML with error message', () => {
      const event: NotificationEvent = { kind: 'error', message: 'Connection refused' };
      const out = r.renderNotification(event);
      expect(out.html).toContain('Connection refused');
    });

    it('activity_tool: HTML with tool name', () => {
      const event: NotificationEvent = { kind: 'activity_tool', toolName: 'Read', toolInput: 'src/main.ts' };
      const out = r.renderNotification(event);
      expect(out.html).toContain('Read');
    });
  });

  describe('renderProgress', () => {
    it('executing phase: shows tool counts and elapsed', () => {
      const snapshot: ProgressSnapshot = {
        phase: 'executing',
        toolCounts: new Map([['Bash', 3], ['Read', 2]]),
        totalTools: 5,
        elapsedSeconds: 12,
        responseText: '',
        permissionQueue: [],
        todoItems: [],
      };
      const out = r.renderProgress(snapshot);
      expect(out.html).toContain('Bash');
      expect(out.html).toContain('12s');
    });

    it('completed phase: shows response text and cost', () => {
      const snapshot: ProgressSnapshot = {
        phase: 'completed',
        toolCounts: new Map([['Bash', 1]]),
        totalTools: 1,
        elapsedSeconds: 5,
        responseText: 'Done, fixed the bug.',
        permissionQueue: [],
        todoItems: [],
        costLine: '$0.03 · 1.5k tokens',
      };
      const out = r.renderProgress(snapshot);
      expect(out.html).toContain('Done, fixed the bug.');
      expect(out.html).toContain('$0.03');
    });

    it('permission phase: shows permission details and buttons', () => {
      const snapshot: ProgressSnapshot = {
        phase: 'permission',
        toolCounts: new Map(),
        totalTools: 0,
        elapsedSeconds: 0,
        responseText: '',
        permissionQueue: [{
          toolName: 'Bash',
          input: 'npm install',
          permId: 'p-1',
          buttons: [
            { label: 'Yes', callbackData: 'perm:allow:p-1', style: 'primary' },
            { label: 'No', callbackData: 'perm:deny:p-1', style: 'danger' },
          ],
        }],
        todoItems: [],
      };
      const out = r.renderProgress(snapshot);
      expect(out.html).toContain('Bash');
      expect(out.html).toContain('npm install');
      expect(out.buttons).toHaveLength(2);
    });
  });

  describe('renderCommandResponse', () => {
    it('renders title, body and fields as HTML', () => {
      const data: CommandResponseData = {
        title: 'Status',
        body: 'All systems operational',
        fields: [{ name: 'Sessions', value: '3 active', inline: true }],
        color: 'success',
      };
      const out = r.renderCommandResponse(data);
      expect(out.html).toContain('Status');
      expect(out.html).toContain('All systems operational');
      expect(out.html).toContain('Sessions');
    });
  });

  describe('renderSimpleText', () => {
    it('wraps plain text in HTML', () => {
      const out = r.renderSimpleText('✅ Permission granted');
      expect(out.html).toContain('Permission granted');
    });

    it('escapes HTML entities', () => {
      const out = r.renderSimpleText('a < b & c > d');
      expect(out.html).toContain('&lt;');
      expect(out.html).toContain('&amp;');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bridge && npx vitest run src/__tests__/telegram-renderer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement TelegramRenderer**

Create `bridge/src/renderers/telegram.ts`. Absorb formatting logic from:
- `bridge/src/formatting/notification.ts:46-63` (telegram switch case)
- `bridge/src/formatting/permission.ts:35-49` (telegram switch case)
- `bridge/src/engine/message-renderer.ts:164-276` (render methods → adapt for HTML output)

Key implementation notes:
- Use `markdownToTelegram()` from `../markdown/telegram.js` for markdown→HTML conversion
- Permission buttons: `perm:allow:${permissionId}` / `perm:deny:${permissionId}` (match existing callback format)
- AskUserQuestion buttons: `askq:${toolUseId}:${index}` per option + `askq:${toolUseId}:skip` (match existing format)
- `renderProgress()`: replicate the executing/done/permission phases from MessageRenderer.render() but output HTML
- `renderSimpleText()`: escape HTML entities, wrap in single `<pre>` or plain text
- `renderCommandResponse()`: `<b>title</b>` + body + fields formatted as `<b>field.name:</b> field.value`
- Tool icons: import `getToolIcon` from `../engine/tool-registry.js`
- Truncation: respect Telegram's 4096-char message limit

```ts
// bridge/src/renderers/telegram.ts
import type { ChannelType } from '../channels/types.js';
import type {
  NotificationRenderer, TelegramOutbound, NotificationEvent,
  ProgressSnapshot, CommandResponseData,
} from './types.js';
import { markdownToTelegram } from '../markdown/telegram.js';
import { getToolIcon } from '../engine/tool-registry.js';
import { redactSensitiveContent } from '../engine/content-filter.js';

const PLATFORM_LIMIT = 4096;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function makePermButtons(permissionId: string) {
  const maxIdBytes = 64 - Buffer.byteLength('perm:allow:', 'utf8');
  const safeId = Buffer.byteLength(permissionId, 'utf8') > maxIdBytes
    ? permissionId.slice(0, maxIdBytes) : permissionId;
  return [
    { label: '✅ Yes', callbackData: `perm:allow:${safeId}`, style: 'primary' as const },
    { label: '❌ No', callbackData: `perm:deny:${safeId}`, style: 'danger' as const },
  ];
}

export class TelegramRenderer implements NotificationRenderer<TelegramOutbound> {
  readonly channelType: ChannelType = 'telegram';

  renderNotification(event: NotificationEvent): TelegramOutbound {
    switch (event.kind) {
      case 'permission_request': {
        const input = truncate(event.toolInput, 300);
        const parts = [
          `🔐 <b>Permission Required</b>`,
          '',
          `<b>Tool:</b> <code>${escapeHtml(event.toolName)}</code>`,
          `<pre>${escapeHtml(input)}</pre>`,
          '',
          `⏱ Expires in ${event.expiresInMinutes ?? 5} minutes`,
          '', '💬 Or reply <b>allow</b> / <b>deny</b>',
        ];
        return { html: parts.join('\n'), buttons: makePermButtons(event.permissionId) };
      }

      case 'ask_user_question': {
        const parts = [`❓ <b>${event.header || 'Question'}</b>`, '', escapeHtml(event.question)];
        const buttons = (event.options ?? []).map((opt, i) => ({
          label: opt.label,
          callbackData: `askq:${event.toolUseId}:${i}`,
        }));
        buttons.push({ label: '⏭ Skip', callbackData: `askq:${event.toolUseId}:skip` });
        return { html: parts.join('\n'), buttons };
      }

      case 'session_complete': {
        const parts = [`✅ <b>Done</b>`];
        if (event.summary) parts.push('', escapeHtml(truncate(event.summary, 3000)));
        if (event.cost) parts.push('', `💰 $${event.cost.costUsd.toFixed(2)} · ${((event.cost.inputTokens + event.cost.outputTokens) / 1000).toFixed(1)}k tokens · ${(event.cost.durationMs / 1000).toFixed(0)}s`);
        return { html: parts.join('\n') };
      }

      case 'error':
        return { html: `❌ <b>Error</b>\n\n<pre>${escapeHtml(truncate(event.message, 2000))}</pre>` };

      case 'todo_update': {
        const lines = event.items.map(t => {
          const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔧' : '⬜';
          return `${icon} ${escapeHtml(t.content)}`;
        });
        const done = event.items.filter(t => t.status === 'completed').length;
        return { html: `📋 <b>Progress (${done}/${event.items.length})</b>\n${lines.join('\n')}` };
      }

      case 'activity_text':
        return { html: escapeHtml(truncate(event.text, 3000)) };

      case 'activity_tool':
        return { html: `▸ <code>${escapeHtml(event.toolName)}</code>${event.toolInput ? ' ' + escapeHtml(truncate(event.toolInput, 200)) : ''}` };

      case 'thinking':
        return { html: event.active ? '🧠 <i>Thinking...</i>' : '' };
    }
  }

  renderProgress(snapshot: ProgressSnapshot): TelegramOutbound {
    switch (snapshot.phase) {
      case 'starting':
        return { html: '⏳ Starting...' };

      case 'permission': {
        const p = snapshot.permissionQueue[0];
        if (!p) return { html: '⏳ Waiting...' };
        const queueHint = snapshot.permissionQueue.length > 1
          ? `\n⏳ +${snapshot.permissionQueue.length - 1} more pending` : '';
        const html = `🔐 <code>${escapeHtml(p.toolName)}</code>: <pre>${escapeHtml(truncate(p.input, 500))}</pre>${queueHint}`;
        return { html: redactSensitiveContent(html), buttons: p.buttons as any };
      }

      case 'executing': {
        const lines: string[] = [];
        if (snapshot.responseText.trim()) {
          lines.push(markdownToTelegram(truncate(snapshot.responseText.trim(), 2000)), '');
        }
        if (snapshot.todoItems.length > 0) {
          const done = snapshot.todoItems.filter(t => t.status === 'completed').length;
          lines.push(`📋 Progress (${done}/${snapshot.todoItems.length})`);
          for (const t of snapshot.todoItems) {
            const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔧' : '⬜';
            lines.push(`${icon} ${escapeHtml(t.content)}`);
          }
          lines.push('');
        }
        if (snapshot.totalTools > 0) {
          const parts: string[] = [];
          for (const [name, count] of snapshot.toolCounts) {
            parts.push(`${getToolIcon(name)} ${name} ×${count}`);
          }
          lines.push(`⏳ ${parts.join(' · ')} (${snapshot.totalTools} tools · ${snapshot.elapsedSeconds}s)`);
        }
        return { html: redactSensitiveContent(lines.join('\n') || '⏳ Working...') };
      }

      case 'completed':
      case 'error': {
        const lines: string[] = [];
        if (snapshot.responseText.trim()) {
          lines.push(markdownToTelegram(snapshot.responseText.trimEnd()));
          lines.push('───────────────');
        }
        if (snapshot.errorMessage) lines.push('⚠️ Stopped');
        if (snapshot.totalTools > 0) {
          const parts: string[] = [];
          for (const [name, count] of snapshot.toolCounts) {
            parts.push(`${getToolIcon(name)} ${name} ×${count}`);
          }
          lines.push(`${parts.join(' · ')} (${snapshot.totalTools} total)`);
        }
        if (snapshot.costLine) lines.push(snapshot.costLine);
        return { html: redactSensitiveContent(lines.join('\n')) };
      }
    }
  }

  renderCommandResponse(data: CommandResponseData): TelegramOutbound {
    const parts: string[] = [`<b>${escapeHtml(data.title)}</b>`];
    if (data.body) parts.push('', markdownToTelegram(data.body));
    if (data.fields) {
      parts.push('');
      for (const f of data.fields) {
        parts.push(`<b>${escapeHtml(f.name)}:</b> ${escapeHtml(f.value)}`);
      }
    }
    return { html: parts.join('\n'), buttons: data.buttons };
  }

  renderSimpleText(text: string): TelegramOutbound {
    return { html: escapeHtml(text) };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd bridge && npx vitest run src/__tests__/telegram-renderer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bridge/src/renderers/telegram.ts bridge/src/__tests__/telegram-renderer.test.ts
git commit -m "feat(renderers): implement TelegramRenderer"
```

---

### Task 3: Discord Renderer

**Files:**
- Create: `bridge/src/renderers/discord.ts`
- Test: `bridge/src/__tests__/discord-renderer.test.ts`
- Reference: `bridge/src/formatting/notification.ts:66-83` (discord case), `bridge/src/formatting/permission.ts:51-68` (discord case)

- [ ] **Step 1: Write failing tests**

Same pattern as Task 2 but verify Discord embed output:
- `renderNotification({ kind: 'permission_request' })` → embed with orange color (0xFFA500), tool fields, buttons
- `renderNotification({ kind: 'session_complete' })` → embed with green color (0x00CC66), code block summary
- `renderProgress({ phase: 'executing' })` → embed with tool counts
- `renderProgress({ phase: 'completed' })` → embed with response text in description
- `renderCommandResponse()` → embed with title, fields
- `renderSimpleText()` → embed with description

Key color map:
```ts
const COLORS = {
  permission: 0xFFA500,  // orange
  question: 0x3399FF,    // blue
  success: 0x00CC66,     // green
  error: 0xFF4444,       // red
  info: 0x888888,        // gray
};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bridge && npx vitest run src/__tests__/discord-renderer.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement DiscordRenderer**

Create `bridge/src/renderers/discord.ts`. Same structure as TelegramRenderer but produces `DiscordOutbound` with `embed` field. Use code blocks (``` ``` ```) for tool input display. Permission and question notifications get colored embeds with footer timestamps.

- [ ] **Step 4: Run tests**

Run: `cd bridge && npx vitest run src/__tests__/discord-renderer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bridge/src/renderers/discord.ts bridge/src/__tests__/discord-renderer.test.ts
git commit -m "feat(renderers): implement DiscordRenderer"
```

---

### Task 4: Feishu Renderer

**Files:**
- Create: `bridge/src/renderers/feishu.ts`
- Test: `bridge/src/__tests__/feishu-renderer.test.ts`
- Reference: `bridge/src/formatting/notification.ts:86-105`, `bridge/src/formatting/permission.ts:70-86`, `bridge/src/formatting/feishu-card.ts`

- [ ] **Step 1: Write failing tests**

Verify Feishu Card 2.0 JSON output:
- `renderNotification({ kind: 'permission_request' })` → card JSON with orange header, markdown elements, buttons
- `renderNotification({ kind: 'session_complete' })` → card JSON with green header
- `renderProgress({ phase: 'executing' })` → card JSON with tool progress
- `renderCommandResponse()` → card JSON with structured fields
- `renderSimpleText()` → card JSON with markdown element

Card JSON structure to verify:
```ts
JSON.parse(out.card) === {
  schema: '2.0',
  config: { wide_screen_mode: true },
  header: { template: 'orange'|'green'|..., title: { tag: 'plain_text', content: '...' } },
  body: { elements: [...] }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bridge && npx vitest run src/__tests__/feishu-renderer.test.ts`

- [ ] **Step 3: Implement FeishuRenderer**

Create `bridge/src/renderers/feishu.ts`. Absorb `buildFeishuCard()` from `formatting/feishu-card.ts` as a private method. Use `downgradeHeadings()` from `../markdown/feishu.js` for card-safe markdown.

Header template map:
```ts
const HEADER_TEMPLATES = {
  permission_request: 'orange',
  ask_user_question: 'blue',
  session_complete: 'green',
  error: 'red',
  todo_update: 'turquoise',
  activity_text: 'turquoise',
  activity_tool: 'turquoise',
  thinking: 'grey',
} as const;
```

- [ ] **Step 4: Run tests**

Run: `cd bridge && npx vitest run src/__tests__/feishu-renderer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bridge/src/renderers/feishu.ts bridge/src/__tests__/feishu-renderer.test.ts
git commit -m "feat(renderers): implement FeishuRenderer"
```

---

### Task 5: MessageRenderer — Add snapshot() Method

**Files:**
- Modify: `bridge/src/engine/message-renderer.ts`
- Modify: `bridge/src/__tests__/message-renderer.test.ts`

- [ ] **Step 1: Write failing test for snapshot()**

Add to existing test file:

```ts
describe('snapshot()', () => {
  it('returns starting phase when no activity', () => {
    const r = createRenderer();
    const s = r.snapshot();
    expect(s.phase).toBe('starting');
    expect(s.totalTools).toBe(0);
    expect(s.responseText).toBe('');
  });

  it('returns executing phase with tool counts', () => {
    const r = createRenderer();
    r.onToolStart('Bash');
    r.onToolStart('Read');
    r.onToolStart('Bash');
    const s = r.snapshot();
    expect(s.phase).toBe('executing');
    expect(s.totalTools).toBe(3);
    expect(s.toolCounts.get('Bash')).toBe(2);
    expect(s.toolCounts.get('Read')).toBe(1);
  });

  it('returns permission phase when permission queued', () => {
    const r = createRenderer();
    r.onPermissionNeeded('Bash', 'npm install', 'p-1', defaultButtons);
    const s = r.snapshot();
    expect(s.phase).toBe('permission');
    expect(s.permissionQueue).toHaveLength(1);
    expect(s.permissionQueue[0].toolName).toBe('Bash');
  });

  it('returns completed phase after onComplete', async () => {
    const r = createRenderer();
    r.onToolStart('Bash');
    r.onComplete(defaultStats);
    await advance(500);
    const s = r.snapshot();
    expect(s.phase).toBe('completed');
    expect(s.costLine).toBeDefined();
  });

  it('returns error phase after onError', async () => {
    const r = createRenderer();
    r.onError('Connection failed');
    await advance(500);
    const s = r.snapshot();
    expect(s.phase).toBe('error');
    expect(s.errorMessage).toBe('Connection failed');
  });

  it('includes todo items', () => {
    const r = createRenderer();
    r.onTodoUpdate([{ content: 'Fix bug', status: 'in_progress' }]);
    const s = r.snapshot();
    expect(s.todoItems).toHaveLength(1);
  });

  it('includes response text', () => {
    const r = createRenderer();
    r.onTextDelta('Hello ');
    r.onTextDelta('world');
    const s = r.snapshot();
    expect(s.responseText).toBe('Hello world');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bridge && npx vitest run src/__tests__/message-renderer.test.ts`
Expected: FAIL — snapshot is not a function

- [ ] **Step 3: Add snapshot() to MessageRenderer**

In `bridge/src/engine/message-renderer.ts`, import `ProgressSnapshot` from `../renderers/types.js` and add:

```ts
snapshot(): ProgressSnapshot {
  let phase: ProgressSnapshot['phase'];
  if (this.completed) phase = 'completed';
  else if (this.errorMessage) phase = 'error';
  else if (this.permissionQueue.length > 0) phase = 'permission';
  else if (this.totalTools > 0 || this.responseText) phase = 'executing';
  else phase = 'starting';

  return {
    phase,
    toolCounts: new Map(this.toolCounts),
    totalTools: this.totalTools,
    elapsedSeconds: this.elapsedSeconds,
    responseText: this.responseText,
    permissionQueue: [...this.permissionQueue],
    todoItems: [...this.todoItems],
    costLine: this.costLine,
    errorMessage: this.errorMessage,
  };
}
```

Keep existing `render()` and all private render methods intact — they will be removed in the cleanup task.

- [ ] **Step 4: Run tests**

Run: `cd bridge && npx vitest run src/__tests__/message-renderer.test.ts`
Expected: ALL PASS (existing + new)

- [ ] **Step 5: Commit**

```bash
git add bridge/src/engine/message-renderer.ts bridge/src/__tests__/message-renderer.test.ts
git commit -m "feat(message-renderer): add snapshot() method for typed rendering pipeline"
```

---

## Phase B: terminal-relay Split

### Task 6: Extract IPCServer + SessionRegistry

**Files:**
- Create: `bridge/src/engine/ipc-server.ts`
- Create: `bridge/src/engine/session-registry.ts`
- Modify: `bridge/src/engine/terminal-relay.ts`

- [ ] **Step 1: Create ipc-server.ts**

Extract from `terminal-relay.ts:6,102-117,210-257`:

```ts
// bridge/src/engine/ipc-server.ts
import { createServer, type Socket, type Server } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { EventEmitter } from 'node:events';

function attachLineParser(socket: Socket, onMessage: (msg: Record<string, unknown>) => void): void {
  let buffer = '';
  socket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { onMessage(JSON.parse(line)); } catch { /* skip */ }
    }
  });
}

export function sendJson(socket: Socket, msg: Record<string, unknown>): void {
  socket.write(JSON.stringify(msg) + '\n');
}

export interface IPCServerEvents {
  message: [payload: Record<string, unknown>, type: string, socket: Socket];
  connect: [socket: Socket];
  disconnect: [socket: Socket];
}

export class IPCServer extends EventEmitter<IPCServerEvents> {
  private server: Server | null = null;
  private clients = new Set<Socket>();

  constructor(private socketPath: string, private log: (msg: string) => void) {
    super();
  }

  get clientCount(): number { return this.clients.size; }

  start(): void {
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);

    this.server = createServer((socket) => {
      this.clients.add(socket);
      this.log(`Terminal connected (${this.clients.size} active)`);
      this.emit('connect', socket);

      attachLineParser(socket, (msg) => {
        this.emit('message', msg.payload as Record<string, unknown>, msg.type as string, socket);
      });

      socket.on('close', () => {
        this.clients.delete(socket);
        this.emit('disconnect', socket);
        this.log(`Terminal disconnected (${this.clients.size} active)`);
      });
      socket.on('error', () => this.clients.delete(socket));
    });

    this.server.listen(this.socketPath, () => this.log(`IPC listening at ${this.socketPath}`));
  }

  stop(): void {
    for (const client of this.clients) client.destroy();
    this.server?.close();
    try { unlinkSync(this.socketPath); } catch { /* gone */ }
  }

  broadcast(msg: Record<string, unknown>): void {
    for (const client of this.clients) sendJson(client, msg);
  }

  reply(socket: Socket, msg: Record<string, unknown>): void {
    sendJson(socket, msg);
  }
}
```

- [ ] **Step 2: Create session-registry.ts**

Extract from `terminal-relay.ts:150-157,183-194,224-235`:

```ts
// bridge/src/engine/session-registry.ts
import type { Socket } from 'node:net';

export interface SessionMeta {
  workdir: string;
  projectName: string;
}

export interface SessionEntry {
  socket: Socket;
  sessionId: string;
  workdir: string;
  projectName: string;
}

export class SessionRegistry {
  private sessions = new Map<string, SessionEntry>();

  register(sessionId: string, socket: Socket, meta: SessionMeta): void {
    this.sessions.set(sessionId, {
      socket, sessionId,
      workdir: meta.workdir,
      projectName: meta.projectName,
    });
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  getSession(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): SessionEntry[] {
    return [...this.sessions.values()];
  }

  getBySocket(socket: Socket): SessionEntry[] {
    return [...this.sessions.values()].filter(s => s.socket === socket);
  }

  /** Remove all sessions owned by a socket (called on disconnect) */
  removeBySocket(socket: Socket): string[] {
    const removed: string[] = [];
    for (const [sid, entry] of this.sessions) {
      if (entry.socket === socket) {
        this.sessions.delete(sid);
        removed.push(sid);
      }
    }
    return removed;
  }
}
```

- [ ] **Step 3: Refactor terminal-relay.ts to use extracted modules**

In `terminal-relay.ts`:
- Import `IPCServer` and `SessionRegistry`
- Replace inline server creation with `this.ipcServer = new IPCServer(this.ipcPath, this.deps.log)`
- Replace `this.sessions` Map with `this.registry = new SessionRegistry()`
- Wire `ipcServer.on('message', ...)` to existing handlers
- Wire `ipcServer.on('disconnect', ...)` to registry cleanup + web client cleanup
- Delegate `broadcast()` to `ipcServer.broadcast()`
- Delegate session methods to `registry.*`

The class shrinks but still works identically from the outside.

- [ ] **Step 4: Run all existing tests**

Run: `cd bridge && npx vitest run`
Expected: ALL PASS (behavior unchanged)

- [ ] **Step 5: Commit**

```bash
git add bridge/src/engine/ipc-server.ts bridge/src/engine/session-registry.ts bridge/src/engine/terminal-relay.ts
git commit -m "refactor(terminal-relay): extract IPCServer and SessionRegistry"
```

---

### Task 7: Extract WebTerminal + ReplyInterceptor + NotificationDispatcher

**Files:**
- Create: `bridge/src/engine/web-terminal.ts`
- Create: `bridge/src/engine/reply-interceptor.ts`
- Create: `bridge/src/engine/notification-dispatcher.ts`
- Modify: `bridge/src/engine/terminal-relay.ts`

- [ ] **Step 1: Create web-terminal.ts**

Extract from `terminal-relay.ts:259-352`. HTTP server + WebSocket server. Takes `SessionRegistry` as dependency for session lookup and WebSocket client tracking.

Key interface:
```ts
export class WebTerminal {
  constructor(deps: {
    port: number;
    token: string;
    webDir: string;
    registry: SessionRegistry;
    log: (msg: string) => void;
  })
  start(): void
  stop(): void
  forwardPtyData(sessionId: string, data: string): void
  onWebInput: ((sessionId: string, data: string) => void) | null
}
```

Move `renderSessionList()` and `MIME` constant into this file.

- [ ] **Step 2: Create reply-interceptor.ts**

Extract from `terminal-relay.ts:399-433`:

```ts
// bridge/src/engine/reply-interceptor.ts
import type { ChannelType } from '../channels/types.js';

export class ReplyInterceptor {
  private trackedMsgIds = new Set<string>();
  onForward: ((msg: Record<string, unknown>) => void) | null = null;

  trackMessage(messageId: string): void {
    this.trackedMsgIds.add(messageId);
  }

  interceptReply(msg: { text: string; replyToMessageId?: string }): boolean {
    if (!msg.replyToMessageId || !this.trackedMsgIds.has(msg.replyToMessageId)) return false;
    this.onForward?.({ type: 'terminal_input', payload: { text: msg.text } });
    return true;
  }

  handleAskCallback(callbackData: string): boolean {
    if (!callbackData.startsWith('askq:')) return false;
    const parts = callbackData.split(':');
    const toolUseId = parts[1];
    const selection = parts[2];
    const answer = selection === 'skip' ? '' : selection;
    const optionIndex = selection === 'skip' ? -1 : parseInt(selection, 10);
    this.onForward?.({ type: 'question_answer', payload: { toolUseId, answer, optionIndex } });
    return true;
  }
}
```

- [ ] **Step 3: Create notification-dispatcher.ts**

```ts
// bridge/src/engine/notification-dispatcher.ts
import type { ChannelType } from '../channels/types.js';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { NotificationRenderer, NotificationEvent, RenderedMessage } from '../renderers/types.js';
import { TargetResolver, type ResolvedTarget } from './target-resolver.js';

export class NotificationDispatcher {
  constructor(
    private getAdapters: () => BaseChannelAdapter[],
    private renderers: Map<ChannelType, NotificationRenderer>,
    private targetResolver: TargetResolver,
    private log: (msg: string) => void,
  ) {}

  async dispatch(event: NotificationEvent): Promise<Map<ChannelType, string>> {
    const results = new Map<ChannelType, string>();
    for (const adapter of this.getAdapters()) {
      const target = this.targetResolver.resolve(adapter.channelType);
      if (!target) continue;

      const renderer = this.renderers.get(adapter.channelType);
      if (!renderer) continue;

      try {
        const rendered = renderer.renderNotification(event);
        // Use sendRendered when available (Task 8), fall back to legacy for now
        const result = await (adapter as any).sendRendered?.(target.chatId, rendered)
          ?? await this.sendLegacy(adapter, target, rendered);
        if (result?.messageId) {
          results.set(adapter.channelType, result.messageId);
          this.log(`Dispatched ${event.kind} → ${adapter.channelType}: ${result.messageId}`);
        }
      } catch (err) {
        this.log(`→ ${adapter.channelType}: ${err}`);
      }
    }
    return results;
  }

  /** Temporary bridge — converts RenderedMessage to OutboundMessage for legacy send() */
  private async sendLegacy(adapter: BaseChannelAdapter, target: ResolvedTarget, rendered: RenderedMessage) {
    const msg: any = { chatId: target.chatId, receiveIdType: target.receiveIdType };
    if ('html' in rendered) msg.html = rendered.html;
    if ('embed' in rendered) msg.embed = rendered.embed;
    if ('card' in rendered) {
      const card = JSON.parse(rendered.card);
      msg.text = card.body?.elements?.[0]?.content ?? '';
      msg.feishuHeader = card.header ? { template: card.header.template, title: card.header.title?.content } : undefined;
      msg.feishuElements = card.body?.elements;
    }
    if (rendered.buttons) msg.buttons = rendered.buttons;
    return adapter.send(msg);
  }
}
```

Also extract `TargetResolver` to its own file `bridge/src/engine/target-resolver.ts` — move the existing `TargetResolver` class, `feishuReceiveIdType()`, and related types from `terminal-relay.ts`.

- [ ] **Step 4: Refactor terminal-relay.ts to delegate**

terminal-relay.ts now imports and delegates to all 5 modules. The class becomes a thin assembly layer:

```ts
export class TerminalRelay {
  private ipcServer: IPCServer;
  private registry: SessionRegistry;
  private webTerminal: WebTerminal;
  private interceptor: ReplyInterceptor;
  private dispatcher: NotificationDispatcher;

  constructor(deps: TerminalRelayDeps) {
    // ... wire all 5 modules
  }

  start(): void {
    this.ipcServer.start();
    this.webTerminal.start();
  }

  stop(): void {
    this.webTerminal.stop();
    this.ipcServer.stop();
  }

  // Public methods delegate to sub-modules
  interceptReply(msg) { return this.interceptor.interceptReply(msg); }
  handleAskCallback(data) { return this.interceptor.handleAskCallback(data); }
  hasActiveClient() { return this.ipcServer.clientCount > 0; }
  // ... etc
}
```

- [ ] **Step 5: Run all tests**

Run: `cd bridge && npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add bridge/src/engine/web-terminal.ts bridge/src/engine/reply-interceptor.ts \
  bridge/src/engine/notification-dispatcher.ts bridge/src/engine/target-resolver.ts \
  bridge/src/engine/terminal-relay.ts
git commit -m "refactor(terminal-relay): extract WebTerminal, ReplyInterceptor, NotificationDispatcher, TargetResolver"
```

---

## Phase C: Adapter Interface Migration

### Task 8: Add sendRendered/editRendered to Adapters

**Files:**
- Modify: `bridge/src/channels/base.ts`
- Modify: `bridge/src/channels/telegram.ts`
- Modify: `bridge/src/channels/discord.ts`
- Modify: `bridge/src/channels/feishu.ts`
- Test: `bridge/src/__tests__/channels.test.ts`

- [ ] **Step 1: Add abstract methods to BaseChannelAdapter**

In `bridge/src/channels/base.ts`, add generic parameter and new methods alongside existing ones:

```ts
import type { RenderedMessage } from '../renderers/types.js';

export abstract class BaseChannelAdapter<T extends RenderedMessage = RenderedMessage> {
  // Existing methods — unchanged (used by non-migrated callers)
  abstract send(message: OutboundMessage): Promise<SendResult>;
  abstract editMessage(chatId: string, messageId: string, message: OutboundMessage): Promise<void>;
  // ... rest unchanged ...

  // New typed methods
  abstract sendRendered(chatId: string, message: T): Promise<SendResult>;
  abstract editRendered(chatId: string, messageId: string, message: T): Promise<void>;
}
```

- [ ] **Step 2: Implement sendRendered in TelegramAdapter**

In `bridge/src/channels/telegram.ts`, add the typed method that accepts `TelegramOutbound`:

```ts
async sendRendered(chatId: string, message: TelegramOutbound): Promise<SendResult> {
  // Build grammy send options from typed message
  const opts: any = { parse_mode: 'HTML' };
  if (message.buttons?.length) {
    opts.reply_markup = this.buildKeyboard(message.buttons);
  }
  const sent = await this.bot.api.sendMessage(chatId, message.html, opts);
  return { messageId: String(sent.message_id), success: true };
}

async editRendered(chatId: string, messageId: string, message: TelegramOutbound): Promise<void> {
  const opts: any = { parse_mode: 'HTML', chat_id: chatId, message_id: Number(messageId) };
  if (message.buttons?.length) {
    opts.reply_markup = this.buildKeyboard(message.buttons);
  } else {
    opts.reply_markup = { inline_keyboard: [] };
  }
  await this.bot.api.editMessageText(chatId, Number(messageId), message.html, opts);
}
```

- [ ] **Step 3: Implement sendRendered in DiscordAdapter**

Accepts `DiscordOutbound`, sends embed via discord.js:

```ts
async sendRendered(chatId: string, message: DiscordOutbound): Promise<SendResult> {
  const channel = await this.client.channels.fetch(chatId);
  if (!channel?.isTextBased()) throw new Error('Invalid channel');
  const embedObj = new EmbedBuilder()
    .setTitle(message.embed.title ?? null)
    .setDescription(message.embed.description ?? null)
    .setColor(message.embed.color ?? null);
  if (message.embed.fields) {
    for (const f of message.embed.fields) embedObj.addFields(f);
  }
  if (message.embed.footer) embedObj.setFooter({ text: message.embed.footer });
  const opts: any = { embeds: [embedObj] };
  if (message.buttons?.length) opts.components = this.buildButtons(message.buttons);
  const sent = await (channel as any).send(opts);
  return { messageId: sent.id, success: true };
}
```

- [ ] **Step 4: Implement sendRendered in FeishuAdapter + auto-detect receiveIdType**

Move `feishuReceiveIdType()` logic into adapter:

```ts
private detectReceiveIdType(chatId: string): string {
  if (chatId.startsWith('ou_')) return 'open_id';
  if (chatId.startsWith('oc_')) return 'chat_id';
  return 'user_id';
}

async sendRendered(chatId: string, message: FeishuOutbound): Promise<SendResult> {
  const receiveIdType = this.detectReceiveIdType(chatId);
  // Send as interactive card
  const resp = await this.client.im.message.create({
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content: message.card,
    },
    params: { receive_id_type: receiveIdType },
  });
  return { messageId: resp.data?.message_id ?? '', success: true };
}
```

- [ ] **Step 5: Run all tests**

Run: `cd bridge && npx vitest run`
Expected: ALL PASS (existing behavior unchanged, new methods added)

- [ ] **Step 6: Commit**

```bash
git add bridge/src/channels/base.ts bridge/src/channels/telegram.ts \
  bridge/src/channels/discord.ts bridge/src/channels/feishu.ts
git commit -m "feat(adapters): add sendRendered/editRendered typed methods alongside legacy send"
```

---

## Phase D: Caller Migration

### Task 9: Migrate Simple Callers — broker, callback-router, bridge-manager

**Files:**
- Modify: `bridge/src/permissions/broker.ts`
- Modify: `bridge/src/engine/callback-router.ts`
- Modify: `bridge/src/engine/bridge-manager.ts`

These callers need access to the correct Renderer for their adapter. The pattern is:

```ts
// Each caller gets a renderers Map injected
private renderers: Map<ChannelType, NotificationRenderer>;

// Instead of: adapter.send({ chatId, text: '✅ Done' })
// Now:        const r = this.renderers.get(adapter.channelType)!;
//             adapter.sendRendered(chatId, r.renderSimpleText('✅ Done'));
```

- [ ] **Step 1: Migrate broker.ts**

Replace `formatPermissionCard()` call + manual spread with Renderer:

```ts
// Before (broker.ts ~line 30-41):
const formatted = formatPermissionCard(data, adapter.channelType as ChannelType);
await adapter.send({ chatId, text: formatted.text, html: formatted.html, ... });

// After:
const renderer = this.renderers.get(adapter.channelType)!;
const event: NotificationEvent = {
  kind: 'permission_request',
  toolName: data.toolName,
  toolInput: data.toolInput,
  permissionId: data.permissionId,
  expiresInMinutes: data.expiresInMinutes,
};
await adapter.sendRendered(chatId, renderer.renderNotification(event));
```

Remove import of `formatPermissionCard`.

- [ ] **Step 2: Migrate callback-router.ts**

8 editMessage calls + 1 send call. Most are simple text:

```ts
// Before: adapter.editMessage(chatId, messageId, { chatId, text: '🔕 Ignored', buttons: [] })
// After:  const r = this.renderers.get(adapter.channelType)!;
//         adapter.editRendered(chatId, messageId, r.renderSimpleText('🔕 Ignored'));

// For feishuHeader conditionals (lines 141-148, 192-197):
// The Renderer handles platform differences internally — no more channelType checks
```

- [ ] **Step 3: Migrate bridge-manager.ts**

5 simple text sends:

```ts
// Before: adapter.send({ chatId, text: '⚠️ Failed to resume...' })
// After:  const r = this.renderers.get(adapter.channelType)!;
//         adapter.sendRendered(chatId, r.renderSimpleText('⚠️ Failed to resume...'));
```

- [ ] **Step 4: Update constructor signatures**

Each module needs `renderers: Map<ChannelType, NotificationRenderer>` in its dependencies. Update construction in `bridge-manager.ts` wiring (where these components are created).

- [ ] **Step 5: Run tests**

Run: `cd bridge && npx vitest run`
Expected: PASS (update test mocks if they mock adapter.send — now need sendRendered mock too)

- [ ] **Step 6: Commit**

```bash
git add bridge/src/permissions/broker.ts bridge/src/engine/callback-router.ts \
  bridge/src/engine/bridge-manager.ts
git commit -m "refactor: migrate broker, callback-router, bridge-manager to Renderer + sendRendered"
```

---

### Task 10: Migrate permission-coordinator

**Files:**
- Modify: `bridge/src/engine/permission-coordinator.ts`

- [ ] **Step 1: Inject Renderer dependency**

Add `renderers: Map<ChannelType, NotificationRenderer>` to constructor.

- [ ] **Step 2: Migrate send calls**

15+ `adapter.send({ chatId, text: '...' })` calls → `adapter.sendRendered(chatId, r.renderSimpleText('...'))`

6 `adapter.editMessage(chatId, msgId, { chatId, text: ..., feishuHeader: ... })` calls → `adapter.editRendered(chatId, msgId, r.renderSimpleText('...'))`

The feishuHeader conditionals disappear — `renderSimpleText` handles platform-specific wrapping internally.

- [ ] **Step 3: Run tests**

Run: `cd bridge && npx vitest run src/__tests__/permission-coordinator.test.ts`
Expected: PASS (update mocks)

- [ ] **Step 4: Commit**

```bash
git add bridge/src/engine/permission-coordinator.ts
git commit -m "refactor: migrate permission-coordinator to Renderer + sendRendered"
```

---

### Task 11: Migrate control-panel + command-router

**Files:**
- Modify: `bridge/src/engine/control-panel.ts`
- Modify: `bridge/src/engine/command-router.ts`

These are the largest migration targets with 7+ platform-switching if/else chains.

- [ ] **Step 1: Migrate control-panel.ts**

Replace `buildMainPanel`, `buildStatsCard`, `renderCard` helper and their platform branches.

Pattern for each card builder:
```ts
// Before (buildMainPanel):
if (channelType === 'telegram') return { chatId, html: '...' };
else if (channelType === 'discord') return { chatId, embed: {...} };
else return { chatId, text: '...', feishuHeader: {...} };

// After:
const r = this.renderers.get(channelType)!;
return r.renderCommandResponse({
  title: 'TLive Control Panel',
  body: statusText,
  buttons: [...],
  color: 'info',
});
```

`adapter.send(msg)` → `adapter.sendRendered(chatId, msg)`
`adapter.editMessage(chatId, msgId, msg)` → `adapter.editRendered(chatId, msgId, msg)`

Remove the private `renderCard()` helper entirely — Renderers replace it.

Remove `OutboundMessage` import.

- [ ] **Step 2: Migrate command-router.ts**

The 7 major platform-switching blocks become Renderer calls:

**Pattern for /status, /sessions, /help (complex commands):**
```ts
// Before:
if (adapter.channelType === 'telegram') {
  await adapter.send({ chatId, html: buildStatusHtml(data) });
} else if (adapter.channelType === 'discord') {
  await adapter.send({ chatId, embed: buildStatusEmbed(data) });
} else {
  await adapter.send({ chatId, text: buildStatusText(data), feishuHeader: {...} });
}

// After:
const r = this.renderers.get(adapter.channelType)!;
await adapter.sendRendered(chatId, r.renderCommandResponse({
  title: 'Status',
  body: statusMarkdown,
  fields: [...],
  color: 'info',
}));
```

**Pattern for simple feedback (30+ calls):**
```ts
// Before: adapter.send({ chatId, text: '⏹ Interrupted' })
// After:  adapter.sendRendered(chatId, r.renderSimpleText('⏹ Interrupted'))
```

- [ ] **Step 3: Run tests**

Run: `cd bridge && npx vitest run src/__tests__/control-panel.test.ts src/__tests__/command-router.test.ts`
Update mocks as needed.

- [ ] **Step 4: Commit**

```bash
git add bridge/src/engine/control-panel.ts bridge/src/engine/command-router.ts
git commit -m "refactor: migrate control-panel and command-router to Renderer — eliminate 7 platform switch chains"
```

---

### Task 12: Migrate sdk-engine

**Files:**
- Modify: `bridge/src/engine/sdk-engine.ts`

This is the most complex migration because it uses MessageRenderer's flushCallback.

- [ ] **Step 1: Update flushCallback to use Renderer**

The flushCallback currently receives `(content: string, isEdit: boolean, buttons?)` from MessageRenderer. Change it to receive `(snapshot: ProgressSnapshot, isEdit: boolean)`:

```ts
// In MessageRenderer constructor options, flushCallback signature changes:
flushCallback: (snapshot: ProgressSnapshot, isEdit: boolean) => Promise<string | void>

// In sdk-engine.ts, the flushCallback implementation:
flushCallback: async (snapshot, isEdit) => {
  const renderer = this.renderers.get(adapter.channelType)!;
  const rendered = renderer.renderProgress(snapshot);

  if (!isEdit) {
    // Feishu streaming: special handling
    if (adapter.channelType === 'feishu' && feishuSession) {
      const card = JSON.parse((rendered as FeishuOutbound).card);
      // use feishuSession.start/update with card content
    }
    const result = await adapter.sendRendered(msg.chatId, rendered);
    return result.messageId;
  } else {
    await adapter.editRendered(msg.chatId, messageId, rendered);
  }
}
```

- [ ] **Step 2: Update MessageRenderer.scheduleFlush to call snapshot()**

In `message-renderer.ts`, change the internal flush path:

```ts
private scheduleFlush(): void {
  if (this.timer) return;
  this.timer = setTimeout(() => {
    this.timer = null;
    const snap = this.snapshot();
    this.doFlush(snap);
  }, this.throttleMs);
}
```

Update `doFlush` to accept `ProgressSnapshot` instead of `string`.

- [ ] **Step 3: Migrate onPermissionTimeout callback**

The `onPermissionTimeout` in sdk-engine.ts currently does inline platform switching. Replace with Renderer:

```ts
// Before:
onPermissionTimeout: async (toolName, input, buttons) => {
  const text = `🔐 ${toolName}: ${input}`;
  const outMsg = adapter.channelType === 'telegram' ? { chatId, html: markdownToTelegram(text), buttons } : { chatId, text, buttons };
  await adapter.send(outMsg);
}

// After:
onPermissionTimeout: async (toolName, input, buttons) => {
  const renderer = this.renderers.get(adapter.channelType)!;
  const event: NotificationEvent = { kind: 'permission_request', toolName, toolInput: input, permissionId: '' };
  await adapter.sendRendered(msg.chatId, renderer.renderNotification(event));
}
```

- [ ] **Step 4: Migrate askSingleQuestion**

sdk-engine.ts line ~291: builds OutboundMessage with inline platform branches. Replace:

```ts
const renderer = this.renderers.get(adapter.channelType)!;
const event: NotificationEvent = {
  kind: 'ask_user_question',
  question: questionText,
  options: question.options,
  toolUseId: question.toolUseId,
  header: question.header,
};
await adapter.sendRendered(msg.chatId, renderer.renderNotification(event));
```

- [ ] **Step 5: Run tests**

Run: `cd bridge && npx vitest run`
Expected: PASS (update message-renderer tests for new flush signature)

- [ ] **Step 6: Commit**

```bash
git add bridge/src/engine/sdk-engine.ts bridge/src/engine/message-renderer.ts \
  bridge/src/__tests__/message-renderer.test.ts
git commit -m "refactor: migrate sdk-engine to Renderer + snapshot-based rendering"
```

---

## Phase E: Terminal-Side IPC Upgrade

### Task 13: Terminal-Side Changes

**Files:**
- Modify: `src/sdk/messageNormalizer.ts`
- Modify: `src/im/notificationHub.ts`
- Modify: `src/loop.ts`

- [ ] **Step 1: Add toNotificationEvent to messageNormalizer.ts**

```ts
// src/sdk/messageNormalizer.ts — add new function, keep existing for now

import type { NotificationEvent } from '../../bridge/src/renderers/types.js';
// OR define a local copy of NotificationEvent to avoid cross-package import
// (check project's import conventions)

export function toNotificationEvent(msg: NormalizedMessage): NotificationEvent | null {
  switch (msg.kind) {
    case 'tool_use': {
      if (msg.toolName === 'AskUserQuestion') {
        const input = msg.toolInput ?? {};
        return {
          kind: 'ask_user_question',
          question: input.question ?? '',
          header: input.header,
          options: input.options,
          toolUseId: msg.toolUseId ?? '',
        };
      }
      return {
        kind: 'activity_tool',
        toolName: msg.toolName ?? 'unknown',
        toolInput: formatToolArgsBrief(msg.toolName, msg.toolInput),
      };
    }
    case 'permission_request':
      return {
        kind: 'permission_request',
        toolName: msg.toolName ?? 'unknown',
        toolInput: formatToolArgsBrief(msg.toolName, msg.toolInput),
        permissionId: msg.permissionId ?? '',
      };
    case 'text':
      return { kind: 'activity_text', text: msg.text ?? '' };
    case 'error':
      return { kind: 'error', message: msg.text ?? 'Unknown error' };
    case 'complete':
      return {
        kind: 'session_complete',
        summary: msg.text ?? '',
        cost: msg.usage,
      };
    default:
      return null;
  }
}

/** Brief tool argument summary for IPC (not for display — Renderer handles display) */
function formatToolArgsBrief(toolName: string | undefined, input: any): string {
  if (!input || typeof input !== 'object') return '';
  if (toolName === 'Bash') return input.command ?? '';
  if (toolName === 'Read') return input.file_path ?? '';
  if (toolName === 'Edit' || toolName === 'Write') return input.file_path ?? '';
  if (toolName === 'Grep') return input.pattern ?? '';
  // Default: first non-empty string value
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.length > 0) return v.slice(0, 200);
  }
  return '';
}
```

- [ ] **Step 2: Update NotificationHub generic type**

In `src/im/notificationHub.ts`, change `NotificationEvent` interface to use the structured type from renderers. The hub's dedup/batch logic stays the same — it operates on the `kind` + `dedupeKey` fields:

```ts
// Update NotificationEvent to carry the structured event payload
export interface NotificationHubEvent {
  kind: NotificationKind;
  dedupeKey: string;
  sessionId: string;
  event: NotificationEvent;  // structured semantic payload
}
```

Update `push()` and `flush()` to use `NotificationHubEvent`.

- [ ] **Step 3: Update loop.ts dispatchToIM**

```ts
// Before:
private async dispatchToIM(events: NotificationEvent[]): Promise<void> {
  for (const event of events) {
    const text = event.body ? `${event.title}\n${event.body}` : event.title;
    const messageId = await this.imSend(this.imChatId, text, event.buttons);

// After:
private async dispatchToIM(events: NotificationHubEvent[]): Promise<void> {
  for (const hubEvent of events) {
    // Send structured event via IPC — bridge Renderer handles formatting
    this.ipc.send('notification', hubEvent.event);
    // Track permission/question messages for reply routing
    // (messageId tracking moves to bridge-side NotificationDispatcher)
  }
```

Update `handleScannerEvent` to produce `NotificationHubEvent` with structured events:

```ts
// Before:
const text = formatForIM(msg);
this.notifications.push({
  kind: 'activity_tool', dedupeKey: ..., sessionId: ...,
  title: text, body: undefined, buttons: undefined,
});

// After:
const event = toNotificationEvent(msg);
if (event) {
  this.notifications.push({
    kind: event.kind as NotificationKind,
    dedupeKey: ..., sessionId: ...,
    event,
  });
}
```

- [ ] **Step 4: Remove formatForIM and imFormatters from messageNormalizer.ts**

Delete the `imFormatters` registry and `formatForIM()` function. Remove the import from `loop.ts`.

- [ ] **Step 5: Run tests**

Run: `npm run test:src` (if terminal-side tests exist) and `cd bridge && npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/sdk/messageNormalizer.ts src/im/notificationHub.ts src/loop.ts
git commit -m "feat: upgrade IPC to structured NotificationEvent — terminal sends semantic data, bridge renders"
```

---

## Phase F: Cleanup

### Task 14: Remove Legacy Code

**Files:**
- Modify: `bridge/src/channels/types.ts` — remove `OutboundMessage` type
- Modify: `bridge/src/channels/base.ts` — remove old `send(message: OutboundMessage)`, rename `sendRendered` → `send`, `editRendered` → `editMessage`
- Modify: `bridge/src/channels/telegram.ts` — remove old send implementation
- Modify: `bridge/src/channels/discord.ts` — remove old send implementation
- Modify: `bridge/src/channels/feishu.ts` — remove old send implementation, remove external `feishuReceiveIdType()` (now internal)
- Delete: `bridge/src/formatting/notification.ts`
- Delete: `bridge/src/formatting/permission.ts`
- Delete: `bridge/src/formatting/feishu-card.ts`
- Delete: `bridge/src/formatting/types.ts`
- Delete: `bridge/src/formatting/index.ts`
- Modify: `bridge/src/engine/message-renderer.ts` — remove old `render()`, `renderExecuting()`, `renderDone()`, `renderTodoProgress()`, `renderToolSummary()`, `applyPlatformLimit()`
- Delete or update: `bridge/src/__tests__/formatting.test.ts` — remove (tests now covered by renderer tests)
- Modify: `bridge/src/engine/terminal-relay.ts` — delete file if assembly moved to main.ts, or keep as thin facade

- [ ] **Step 1: Rename sendRendered → send in BaseChannelAdapter**

```ts
// base.ts: remove old send/editMessage, rename
abstract send(chatId: string, message: T): Promise<SendResult>;  // was sendRendered
abstract editMessage(chatId: string, messageId: string, message: T): Promise<void>;  // was editRendered
```

- [ ] **Step 2: Update all 3 adapters — rename methods**

In each adapter file, rename `sendRendered` → `send` and `editRendered` → `editMessage`. Remove old implementations that accepted `OutboundMessage`.

- [ ] **Step 3: Remove OutboundMessage from types.ts**

Delete the `OutboundMessage` interface. Keep `InboundMessage`, `ChannelType`, `SendResult`, `Button`, `FileAttachment`.

- [ ] **Step 4: Search and fix any remaining OutboundMessage references**

Run: `grep -r 'OutboundMessage' bridge/src/ --include='*.ts' -l`
Fix any remaining imports.

- [ ] **Step 5: Delete formatting/ directory**

```bash
rm bridge/src/formatting/notification.ts bridge/src/formatting/permission.ts \
   bridge/src/formatting/feishu-card.ts bridge/src/formatting/types.ts \
   bridge/src/formatting/index.ts
rmdir bridge/src/formatting
```

- [ ] **Step 6: Remove old render methods from MessageRenderer**

Delete: `render()`, `renderExecuting()`, `renderDone()`, `renderTodoProgress()`, `renderToolSummary()`, `applyPlatformLimit()`. Update tests.

- [ ] **Step 7: Delete formatting.test.ts**

The test coverage is now in `telegram-renderer.test.ts`, `discord-renderer.test.ts`, `feishu-renderer.test.ts`.

- [ ] **Step 8: Run full test suite**

Run: `cd bridge && npx vitest run`
Expected: ALL PASS

- [ ] **Step 9: Search for dead code**

```bash
grep -r 'formatPermissionCard\|formatNotification\|buildFeishuCard\|sendCompat\|OutboundMessage' \
  bridge/src/ src/ --include='*.ts' -l
```

Fix any remaining references.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "cleanup: remove OutboundMessage, formatting/, and legacy adapter methods — migration complete"
```

---

## Verification Checklist

After all tasks complete:

- [ ] `cd bridge && npx vitest run` — all tests pass
- [ ] `npm run test:src` — terminal-side tests pass (if any)
- [ ] `npx tsc --noEmit` — no type errors in bridge/
- [ ] `grep -r 'OutboundMessage' bridge/src/ src/ --include='*.ts'` — zero results
- [ ] `grep -r 'formatPermissionCard\|formatNotification' bridge/src/ --include='*.ts'` — zero results
- [ ] `grep -r 'text\.includes.*Permission' bridge/src/ --include='*.ts'` — zero results (no more guessing)
- [ ] `wc -l bridge/src/engine/terminal-relay.ts` — under 80 lines (thin assembly)
- [ ] `ls bridge/src/formatting/` — directory doesn't exist
- [ ] `ls bridge/src/renderers/` — contains types.ts, telegram.ts, discord.ts, feishu.ts
