// src/loop.ts
// Main coordination loop for `tlive claude`.
// Wires SessionManager, NotificationHub, SessionRouter, and IM transport.

import { EventEmitter } from 'node:events';
import { SessionManager, type SessionState, type ScannerFactory } from './core/sessionManager.js';
import { ProjectRegistry } from './core/projectRegistry.js';
import { NotificationHub, type NotificationEvent as HubNotificationEvent } from './im/notificationHub.js';
import { SessionRouter } from './im/sessionRouter.js';
import type { ProviderAdapter, NormalizedMessage } from './sdk/providerAdapter.js';
import type { ToolUseEvent, SessionEvent } from './core/sessionScanner.js';
import type { TLiveConfig } from './config.js';
import { CostTracker } from './core/costTracker.js';
import { ScannerContext, type ScannerContextSnapshot } from './core/scannerContext.js';
import type { NotificationEvent as BridgeNotificationEvent } from './sdk/sharedEvents.js';

const MAX_IM_TEXT_LEN = 300;

export interface LoopOptions {
  workdir: string;
  adapter: ProviderAdapter;
  config: TLiveConfig;
  ctx: ScannerContext;
  sessionId?: string;
  scannerFactory?: ScannerFactory;
}

export interface IMSendFn {
  (
    chatId: string,
    text: string,
    buttons?: HubNotificationEvent['buttons'],
    event?: BridgeNotificationEvent,
    sessionCtx?: ScannerContextSnapshot,
  ): Promise<string | undefined>;
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
  private readonly ctx: ScannerContext;
  private lastTerminalInputAt = Date.now();

  constructor(opts: LoopOptions) {
    super();
    this.config = opts.config;
    this.adapter = opts.adapter;
    this.ctx = opts.ctx;
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
    this.notifications.on('notify', (events: HubNotificationEvent[]) => this.dispatchToIM(events));
  }

  // ---------------------------------------------------------------------------
  // Scanner activity → IM sync
  // ---------------------------------------------------------------------------

  private handleScannerEvent(event: SessionEvent): void {
    const raw = event.raw as Record<string, unknown>;
    if (raw.isMeta) return;

    // Provider-agnostic boundary: adapter owns the shape → NotificationEvent mapping.
    const events = this.adapter.toEvents?.(raw, this.ctx.snapshot) ?? [];

    // Codex emits token_count as event_msg → feed to CostTracker.
    const usage = this.adapter.extractUsage?.(raw);
    if (usage) this.costTracker.addUsage(usage);

    for (const bridgeEvent of events) {
      const dedupeKey = `activity:${event.uuid}:${bridgeEvent.kind}`;
      const hubEvent = this.toHubEvent(bridgeEvent, dedupeKey);
      if (hubEvent) this.notifications.push(hubEvent);
    }
  }

  /**
   * Wrap a bridge NotificationEvent in the hub envelope (dedupeKey + fallback text).
   * title/body on the envelope are only used for plain-text fallback when a channel
   * lacks a renderer; the real rendering happens on the bridge side via the decorator
   * + platform-specific renderer.
   */
  private toHubEvent(e: BridgeNotificationEvent, dedupeKey: string): HubNotificationEvent | null {
    switch (e.kind) {
      case 'activity_text':
        return {
          kind: 'activity_text',
          dedupeKey,
          sessionId: this.ctx.snapshot.sessionId,
          title: '',
          body: e.text.slice(0, MAX_IM_TEXT_LEN),
          event: e,
        };
      case 'activity_tool':
        return {
          kind: 'activity_tool',
          dedupeKey,
          sessionId: this.ctx.snapshot.sessionId,
          title: '',
          body: `${e.toolName}${e.toolInput ? `: ${e.toolInput}` : ''}`,
          event: e,
        };
      case 'ask_user_question': {
        const buttons: Array<{ label: string; callbackData: string; style?: 'primary' | 'danger' }> = [];
        if (e.options) {
          for (let i = 0; i < e.options.length; i++) {
            buttons.push({ label: e.options[i].label, callbackData: `askq:${e.toolUseId}:${i}` });
          }
          buttons.push({ label: 'Skip', callbackData: `askq:${e.toolUseId}:skip`, style: 'danger' });
        }
        return {
          kind: 'ask_user_question',
          dedupeKey: `askq:${e.toolUseId}`,
          sessionId: this.ctx.snapshot.sessionId,
          title: '',
          body: e.question,
          buttons: buttons.length > 0 ? buttons : undefined,
          event: e,
        };
      }
      case 'todo_update':
        return {
          kind: 'todo_update',
          dedupeKey: `todo:${dedupeKey}`,
          sessionId: this.ctx.snapshot.sessionId,
          title: '',
          body: '',
          event: e,
        };
      case 'error':
        return {
          kind: 'error',
          dedupeKey,
          sessionId: this.ctx.snapshot.sessionId,
          title: '',
          body: e.message,
          event: e,
        };
      default:
        // permission_request, thinking, reasoning_summary, file_change_list, session_complete,
        // activity_tool (covered above) — not emitted via toEvents directly. session_complete
        // is pushed from handleSessionComplete; permission_request from handlePermissionNeeded.
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Permission detection → IM alert
  // ---------------------------------------------------------------------------

  private handlePermissionNeeded(toolUse: ToolUseEvent): void {
    let e: BridgeNotificationEvent;
    try {
      e = this.adapter.toPermissionEvent!(toolUse, this.ctx.snapshot);
    } catch {
      // Provider without a scanner-path permission broker (codex): nothing to do.
      return;
    }

    if (e.kind === 'ask_user_question') {
      const buttons: Array<{ label: string; callbackData: string; style?: 'primary' | 'danger' }> = [];
      if (e.options) {
        for (let i = 0; i < e.options.length; i++) {
          buttons.push({ label: e.options[i].label, callbackData: `askq:${e.toolUseId}:${i}` });
        }
      }
      buttons.push({ label: 'Skip', callbackData: `askq:${e.toolUseId}:skip`, style: 'danger' });
      this.notifications.push({
        kind: 'ask_user_question',
        dedupeKey: `askq:${e.toolUseId}`,
        sessionId: this.ctx.snapshot.sessionId,
        title: '',
        body: e.question,
        buttons,
        event: e,
      });
      return;
    }

    if (e.kind === 'permission_request') {
      this.notifications.push({
        kind: 'permission_request',
        dedupeKey: `perm:${e.permissionId}`,
        sessionId: this.ctx.snapshot.sessionId,
        title: '',
        body: `${e.toolName}: ${e.toolInput}`,
        buttons: [
          { label: 'Allow', callbackData: `perm:allow:${e.permissionId}` },
          { label: 'Deny', callbackData: `perm:deny:${e.permissionId}`, style: 'danger' as const },
          { label: 'Takeover', callbackData: `perm:takeover:${e.permissionId}` },
        ],
        event: e,
      });
    }
  }

  private handleSessionComplete(): void {
    const summary = this.costTracker.formatSummary();
    this.notifications.push({
      kind: 'session_complete',
      dedupeKey: `complete:${this.ctx.snapshot.sessionId}`,
      sessionId: this.ctx.snapshot.sessionId,
      title: '',
      body: summary,
      // Decorator injects terminalUrl + resumeHint on the bridge side.
      event: { kind: 'session_complete', summary },
    });
  }

  // ---------------------------------------------------------------------------
  // Notification dispatch → IM
  // ---------------------------------------------------------------------------

  private async dispatchToIM(events: HubNotificationEvent[]): Promise<void> {
    if (!this.imSend || !this.imChatId) return;
    for (const event of events) {
      const text = event.body ? `${event.title}\n${event.body}` : event.title;
      const messageId = await this.imSend(
        this.imChatId,
        text,
        event.buttons,
        event.event,
        this.ctx.snapshot,
      );
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
        this.handlePermissionNeeded({
          toolUseId: id,
          toolName,
          input,
          timestamp: Date.now(),
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
