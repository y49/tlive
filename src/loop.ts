// src/loop.ts
// Main coordination loop for `tlive claude`.
// Wires SessionManager, NotificationHub, SessionRouter, and IM transport.

import { EventEmitter } from 'node:events';
import { SessionManager, type SessionState, type ScannerFactory } from './core/sessionManager.js';
import { ProjectRegistry } from './core/projectRegistry.js';
import { NotificationHub, type NotificationEvent } from './im/notificationHub.js';
import { SessionRouter } from './im/sessionRouter.js';
import type { ProviderAdapter, NormalizedMessage } from './sdk/providerAdapter.js';
import type { ToolUseEvent, SessionEvent } from './core/sessionScanner.js';
import { normalizeSessionLine, formatForIM, toNotificationEvent, formatToolArgsBrief, extractTodos, formatTodos } from './sdk/messageNormalizer.js';
import type { StructuredNotificationEvent } from './sdk/messageNormalizer.js';
import type { TLiveConfig } from './config.js';
import type { NotificationKind } from './im/notificationRules.js';
import { CostTracker } from './core/costTracker.js';
import { LABEL } from './im/icons.js';

const MAX_IM_TEXT_LEN = 300;

export interface LoopOptions {
  workdir: string;
  adapter: ProviderAdapter;
  config: TLiveConfig;
  sessionId?: string;
  scannerFactory?: ScannerFactory;
}

export interface IMSendFn {
  (chatId: string, text: string, buttons?: NotificationEvent['buttons'], event?: StructuredNotificationEvent): Promise<string | undefined>;
}

export class TLiveLoop extends EventEmitter {
  private session: SessionManager;
  private registry: ProjectRegistry;
  private notifications: NotificationHub;
  private router: SessionRouter;
  private config: TLiveConfig;
  private adapter: ProviderAdapter;
  private costTracker: CostTracker;
  private imSend?: IMSendFn;
  private imChatId?: string;
  private lastTerminalInputAt = Date.now();

  constructor(opts: LoopOptions) {
    super();
    this.config = opts.config;
    this.adapter = opts.adapter;
    this.costTracker = new CostTracker();
    this.registry = new ProjectRegistry();
    this.notifications = new NotificationHub({
      batchDelay: opts.config.messageBatchDelay,
      isUserActive: () => this.isUserActive(),
    });
    this.router = new SessionRouter();
    this.session = new SessionManager({
      sessionId: opts.sessionId, workdir: opts.workdir,
      adapter: opts.adapter, config: opts.config,
      scannerFactory: opts.scannerFactory,
    });
    this.registry.register(opts.workdir);
    this.wireEvents();
  }

  get sessionInfo() { return this.session.info; }
  get sessionState(): SessionState { return this.session.state; }

  setIMTarget(chatId: string, sendFn: IMSendFn): void {
    this.imChatId = chatId;
    this.imSend = sendFn;
  }

  private isUserActive(): boolean {
    return Date.now() - this.lastTerminalInputAt < this.config.activeThreshold;
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------

  private wireEvents(): void {
    this.session.on('ptyData', (data: string) => this.emit('ptyData', data));
    this.session.on('scannerEvent', (event: SessionEvent) => this.handleScannerEvent(event));
    this.session.on('permissionNeeded', (toolUse: ToolUseEvent) => this.handlePermissionNeeded(toolUse));
    this.session.on('permissionResolved', (id: string) => {
      this.notifications.cancel(`perm:${id}`);
      this.notifications.cancel(`askq:${id}`);
    });
    this.session.on('sdkMessage', (msg: NormalizedMessage) => this.emit('sdkMessage', msg));
    this.session.on('thinking', (thinking: boolean) => {
      this.notifications.push({
        kind: 'thinking',
        dedupeKey: `thinking:${this.session.info.sessionId}:${thinking ? 'on' : 'off'}`,
        sessionId: this.session.info.sessionId,
        title: thinking ? `💭 ${this.sessionTag()}` : `${this.sessionTag()}`,
        body: thinking ? 'Thinking…' : undefined,
        event: { kind: 'thinking', active: thinking },
      });
    });
    this.session.on('usage', (usage: Record<string, unknown>) => this.costTracker.addUsage(usage));
    this.session.on('model', (model: string) => this.costTracker.setModel(model));
    this.session.on('sessionComplete', () => this.handleSessionComplete());
    this.notifications.on('notify', (events: NotificationEvent[]) => this.dispatchToIM(events));
  }

  // ---------------------------------------------------------------------------
  // Scanner activity → IM sync
  // ---------------------------------------------------------------------------

  private handleScannerEvent(event: SessionEvent): void {
    const raw = event.raw as Record<string, unknown>;
    if (raw.isMeta) return;

    const normalized = normalizeSessionLine(
      { uuid: event.uuid, type: event.type, message: event.message },
      this.adapter.name as 'claude' | 'codex',
      this.session.info.sessionId,
    );

    for (const msg of normalized) {
      if (msg.kind !== 'tool_use') {
        // Text activity → push with reply hint
        const text = formatForIM(msg);
        if (!text) continue;
        const body = text.length > MAX_IM_TEXT_LEN ? text.slice(0, MAX_IM_TEXT_LEN) + '...' : text;
        const structEvent = toNotificationEvent(msg);
        this.notifications.push({
          kind: 'activity_text',
          dedupeKey: `activity:${event.uuid}:${msg.kind}`,
          sessionId: this.session.info.sessionId,
          title: `${LABEL.terminal} · ${this.sessionTag()}`,
          body: body + `\n\n${LABEL.replyHint}`,
          event: structEvent ?? undefined,
        });
        continue;
      }

      // --- tool_use handling: route by tool name ---

      // AskUserQuestion → immediate notification with option buttons
      // Real Claude format: { questions: [{ question, header, options: [{label, description}], multiSelect }] }
      if (msg.toolName === 'AskUserQuestion') {
        const input = msg.toolInput as Record<string, unknown> | undefined;
        const questions = input?.questions as Array<Record<string, unknown>> | undefined;
        const firstQ = Array.isArray(questions) ? questions[0] : input;
        const questionText = (firstQ?.question as string) ?? '';
        const rawOptions = Array.isArray(firstQ?.options) ? firstQ.options as Array<Record<string, unknown>> : [];
        const options = rawOptions.map(o => (o.label ?? o.description ?? '?') as string);

        // Use tool_use block ID for dedup — must match handlePermissionNeeded's key
        const blockId = msg.toolUseId || event.uuid;
        const buttons: Array<{ label: string; callbackData: string; style?: 'primary' | 'danger' }> = [];
        for (let i = 0; i < options.length; i++) {
          buttons.push({ label: options[i], callbackData: `askq:${blockId}:${i}` });
        }
        if (buttons.length > 0) {
          buttons.push({ label: 'Skip', callbackData: `askq:${blockId}:skip`, style: 'danger' });
        }
        const askEvent = toNotificationEvent(msg);
        this.notifications.push({
          kind: 'ask_user_question',
          dedupeKey: `askq:${blockId}`,
          sessionId: this.session.info.sessionId,
          title: `${LABEL.question} · ${this.sessionTag()}`,
          body: questionText || 'Question from Claude',
          buttons: buttons.length > 0 ? buttons : undefined,
          event: askEvent ?? undefined,
        });
        continue;
      }

      // TodoWrite → structured task list
      if (msg.toolName === 'TodoWrite') {
        const todos = extractTodos(msg.toolInput);
        if (todos) {
          this.notifications.push({
            kind: 'todo_update',
            dedupeKey: `todo:${event.uuid}`,
            sessionId: this.session.info.sessionId,
            title: `${LABEL.tasks} · ${this.sessionTag()}`,
            body: formatTodos(todos),
            event: { kind: 'todo_update', items: todos },
          });
          continue;
        }
      }

      // Other tools → activity notification
      const text = formatForIM(msg);
      if (!text) continue;
      const toolEvent = toNotificationEvent(msg);
      this.notifications.push({
        kind: 'activity_tool',
        dedupeKey: `activity:${event.uuid}:tool`,
        sessionId: this.session.info.sessionId,
        title: `${LABEL.terminal} · ${this.sessionTag()}`,
        body: text,
        event: toolEvent ?? undefined,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Permission detection → IM alert
  // ---------------------------------------------------------------------------

  private handlePermissionNeeded(toolUse: ToolUseEvent): void {
    if (toolUse.toolName === 'AskUserQuestion') {
      // Build option buttons if question has options
      const buttons: Array<{ label: string; callbackData: string; style?: 'primary' | 'danger' }> = [];
      if (toolUse.questionOptions) {
        for (let i = 0; i < toolUse.questionOptions.length; i++) {
          buttons.push({
            label: toolUse.questionOptions[i],
            callbackData: `askq:${toolUse.toolUseId}:${i}`,
          });
        }
      }
      buttons.push({
        label: 'Skip',
        callbackData: `askq:${toolUse.toolUseId}:skip`,
        style: 'danger',
      });

      this.notifications.push({
        kind: 'ask_user_question',
        dedupeKey: `askq:${toolUse.toolUseId}`,
        sessionId: this.session.info.sessionId,
        title: `${LABEL.question} · ${this.sessionTag()}`,
        body: toolUse.questionText ?? 'Question from Claude',
        buttons,
        event: {
          kind: 'ask_user_question',
          question: toolUse.questionText ?? 'Question from Claude',
          toolUseId: toolUse.toolUseId,
        },
      });
      return;
    }

    // Regular permission request
    this.notifications.push({
      kind: 'permission_request',
      dedupeKey: `perm:${toolUse.toolUseId}`,
      sessionId: this.session.info.sessionId,
      title: `${LABEL.permission} · ${this.sessionTag()}`,
      body: formatForIM({
        kind: 'permission_request', provider: this.adapter.name as 'claude' | 'codex',
        sessionId: this.session.info.sessionId,
        toolName: toolUse.toolName, toolInput: toolUse.input,
      }),
      buttons: [
        { label: 'Allow', callbackData: `perm:allow:${toolUse.toolUseId}` },
        { label: 'Deny', callbackData: `perm:deny:${toolUse.toolUseId}`, style: 'danger' as const },
        { label: 'Takeover', callbackData: `perm:takeover:${toolUse.toolUseId}` },
      ],
      event: {
        kind: 'permission_request',
        toolName: toolUse.toolName,
        toolInput: formatToolArgsBrief(toolUse.toolName, toolUse.input),
        permissionId: toolUse.toolUseId,
      },
    });
  }

  private handleSessionComplete(): void {
    const summary = this.costTracker.formatSummary();
    this.notifications.push({
      kind: 'session_complete',
      dedupeKey: `complete:${this.session.info.sessionId}`,
      sessionId: this.session.info.sessionId,
      title: `${LABEL.done} · ${this.sessionTag()}`,
      body: summary,
      event: { kind: 'session_complete', summary },
    });
  }

  // ---------------------------------------------------------------------------
  // Notification dispatch → IM
  // ---------------------------------------------------------------------------

  private async dispatchToIM(events: NotificationEvent[]): Promise<void> {
    if (!this.imSend || !this.imChatId) return;
    for (const event of events) {
      const text = event.body ? `${event.title}\n${event.body}` : event.title;
      const messageId = await this.imSend(this.imChatId, text, event.buttons, event.event);
      if (messageId && (event.kind === 'permission_request' || event.kind === 'ask_user_question')) {
        this.router.registerTerminalNotification(
          messageId, this.session.info.sessionId, this.session.info.workdir,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // IM action handlers — strategy map
  // ---------------------------------------------------------------------------

  private readonly actionHandlers: Record<string, (toolUseId: string) => Promise<void>> = {
    takeover: (toolUseId) => this.handleTakeover(toolUseId),
    allow:    (toolUseId) => this.handlePermissionDecision(toolUseId, 'allow'),
    deny:     (toolUseId) => this.handlePermissionDecision(toolUseId, 'deny'),
  };

  async handleIMAction(action: string, toolUseId: string): Promise<void> {
    const handler = this.actionHandlers[action];
    if (handler) await handler(toolUseId);
  }

  private async handleTakeover(_toolUseId: string): Promise<void> {
    await this.session.handoffToSDK({
      onPermissionRequest: (id, toolName, input) => {
        this.notifications.push({
          kind: 'permission_request', dedupeKey: `perm:${id}`,
          sessionId: this.session.info.sessionId,
          title: `${LABEL.permission}: ${toolName}`,
          body: formatForIM({
            kind: 'permission_request', provider: this.adapter.name as 'claude' | 'codex',
            sessionId: this.session.info.sessionId,
            toolName, toolInput: input,
          }),
          buttons: [
            { label: 'Allow', callbackData: `perm:allow:${id}` },
            { label: 'Deny', callbackData: `perm:deny:${id}`, style: 'danger' as const },
          ],
          event: {
            kind: 'permission_request',
            toolName,
            toolInput: formatToolArgsBrief(toolName, input),
            permissionId: id,
          },
        });
      },
    });
  }

  private async handlePermissionDecision(toolUseId: string, decision: 'allow' | 'deny'): Promise<void> {
    if (this.session.state === 'sdk_active') {
      this.session.resolvePermission(toolUseId, decision);
    } else {
      // Need to handoff to SDK first, then resolve
      await this.session.handoffToSDK({
        onPermissionRequest: (id) => {
          setTimeout(() => this.session.resolvePermission(id, decision), 100);
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Terminal input
  // ---------------------------------------------------------------------------

  async handleTerminalInput(data: string): Promise<void> {
    this.lastTerminalInputAt = Date.now();
    if (this.session.state === 'sdk_active') {
      await this.session.takebackToTerminal();
    } else {
      this.session.writeToPTY(data);
    }
  }

  async start(): Promise<void> { await this.session.startPTY(); }

  async stop(): Promise<void> {
    this.notifications.reset();
    await this.session.stop();
  }

  /** Project name for IM display (last non-empty path segment). */
  private projectName(): string {
    const parts = this.session.info.workdir.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : 'unknown';
  }

  /** Short session tag: project · #session-prefix */
  private sessionTag(): string {
    return `${this.projectName()} · #${this.session.info.sessionId.slice(0, 6)}`;
  }
}
