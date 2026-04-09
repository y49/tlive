// src/loop.ts
// Main coordination loop for `tlive claude`.
// Wires SessionManager, NotificationHub, SessionRouter, and IM transport.

import { EventEmitter } from 'node:events';
import { SessionManager, type SessionState } from './core/sessionManager.js';
import { ProjectRegistry } from './core/projectRegistry.js';
import { NotificationHub, type NotificationEvent } from './im/notificationHub.js';
import { SessionRouter } from './im/sessionRouter.js';
import type { ProviderAdapter, NormalizedMessage } from './sdk/providerAdapter.js';
import type { ToolUseEvent, SessionEvent } from './core/sessionScanner.js';
import { normalizeSessionLine, formatForIM } from './sdk/messageNormalizer.js';
import type { TLiveConfig } from './config.js';
import type { NotificationKind } from './im/notificationRules.js';

const MAX_IM_TEXT_LEN = 300;

export interface LoopOptions {
  workdir: string;
  adapter: ProviderAdapter;
  config: TLiveConfig;
  sessionId?: string;
}

export interface IMSendFn {
  (chatId: string, text: string, buttons?: NotificationEvent['buttons']): Promise<string | undefined>;
}

export class TLiveLoop extends EventEmitter {
  private session: SessionManager;
  private registry: ProjectRegistry;
  private notifications: NotificationHub;
  private router: SessionRouter;
  private config: TLiveConfig;
  private imSend?: IMSendFn;
  private imChatId?: string;
  private lastTerminalInputAt = Date.now();

  constructor(opts: LoopOptions) {
    super();
    this.config = opts.config;
    this.registry = new ProjectRegistry();
    this.notifications = new NotificationHub({
      batchDelay: opts.config.messageBatchDelay,
      isUserActive: () => this.isUserActive(),
    });
    this.router = new SessionRouter();
    this.session = new SessionManager({
      sessionId: opts.sessionId, workdir: opts.workdir,
      adapter: opts.adapter, config: opts.config,
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
    this.session.on('permissionResolved', (id: string) => this.notifications.cancel(`perm:${id}`));
    this.session.on('sdkMessage', (msg: NormalizedMessage) => this.emit('sdkMessage', msg));
    this.session.on('thinking', (thinking: boolean) => {
      if (thinking) {
        this.notifications.push({
          kind: 'thinking',
          dedupeKey: 'thinking:on',
          sessionId: this.session.info.sessionId,
          title: `\u{1F914} Thinking... \u00B7 ${this.sessionTag()}`,
        });
      }
    });
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
      'claude', this.session.info.sessionId,
    );

    for (const msg of normalized) {
      const text = formatForIM(msg);
      if (!text) continue;

      const body = text.length > MAX_IM_TEXT_LEN
        ? text.slice(0, MAX_IM_TEXT_LEN) + '...'
        : text;

      const notifKind: NotificationKind = msg.kind === 'tool_use' ? 'activity_tool' : 'activity_text';
      this.notifications.push({
        kind: notifKind,
        dedupeKey: `activity:${event.uuid}:${msg.kind}`,
        sessionId: this.session.info.sessionId,
        title: `Terminal · ${this.sessionTag()}`,
        body,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Permission detection → IM alert
  // ---------------------------------------------------------------------------

  private handlePermissionNeeded(toolUse: ToolUseEvent): void {
    const isQuestion = toolUse.toolName === 'AskUserQuestion';
    this.notifications.push({
      kind: isQuestion ? 'ask_user_question' : 'permission_request',
      dedupeKey: `perm:${toolUse.toolUseId}`,
      sessionId: this.session.info.sessionId,
      title: isQuestion
        ? `❓ Claude asks · ${this.sessionTag()}`
        : `⚠️ Permission · ${this.sessionTag()}`,
      body: formatForIM({
        kind: 'permission_request', provider: 'claude',
        sessionId: this.session.info.sessionId,
        toolName: toolUse.toolName, toolInput: toolUse.input,
      }),
      buttons: isQuestion ? undefined : [
        { label: 'Allow', callbackData: `perm:allow:${toolUse.toolUseId}` },
        { label: 'Deny', callbackData: `perm:deny:${toolUse.toolUseId}`, style: 'danger' as const },
        { label: 'Takeover', callbackData: `perm:takeover:${toolUse.toolUseId}` },
      ],
    });
  }

  private handleSessionComplete(): void {
    this.notifications.push({
      kind: 'session_complete',
      dedupeKey: `complete:${this.session.info.sessionId}`,
      sessionId: this.session.info.sessionId,
      title: `✅ Done · ${this.sessionTag()}`,
    });
  }

  // ---------------------------------------------------------------------------
  // Notification dispatch → IM
  // ---------------------------------------------------------------------------

  private async dispatchToIM(events: NotificationEvent[]): Promise<void> {
    if (!this.imSend || !this.imChatId) return;
    for (const event of events) {
      const text = event.body ? `${event.title}\n${event.body}` : event.title;
      const messageId = await this.imSend(this.imChatId, text, event.buttons);
      if (messageId && event.kind === 'permission_request') {
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
          title: `⚠️ ${toolName}`,
          body: formatForIM({
            kind: 'permission_request', provider: 'claude',
            sessionId: this.session.info.sessionId,
            toolName, toolInput: input,
          }),
          buttons: [
            { label: 'Allow', callbackData: `perm:allow:${id}` },
            { label: 'Deny', callbackData: `perm:deny:${id}`, style: 'danger' as const },
          ],
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
