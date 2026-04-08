// src/loop.ts
import { EventEmitter } from 'node:events';
import { SessionManager, type SessionState } from './core/sessionManager.js';
import { ProjectRegistry } from './core/projectRegistry.js';
import { NotificationHub, type NotificationEvent } from './im/notificationHub.js';
import { SessionRouter } from './im/sessionRouter.js';
import type { ProviderAdapter, NormalizedMessage } from './sdk/providerAdapter.js';
import type { ToolUseEvent } from './core/sessionScanner.js';
import { formatForIM } from './sdk/messageNormalizer.js';
import type { TLiveConfig } from './config.js';

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

  constructor(opts: LoopOptions) {
    super();
    this.config = opts.config;
    this.registry = new ProjectRegistry();
    this.notifications = new NotificationHub({ batchDelay: opts.config.messageBatchDelay });
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

  private wireEvents(): void {
    this.session.on('ptyData', (data: string) => this.emit('ptyData', data));

    this.session.on('permissionNeeded', (toolUse: ToolUseEvent) => {
      const isQuestion = toolUse.toolName === 'AskUserQuestion';
      this.notifications.push({
        kind: isQuestion ? 'question' : 'permission_required',
        dedupeKey: `perm:${toolUse.toolUseId}`,
        severity: 'warning',
        requiresUserAction: true,
        sessionId: this.session.info.sessionId,
        title: isQuestion
          ? `❓ Claude asks · ${this.shortWorkdir()}`
          : `⚠️ Claude waiting · ${this.shortWorkdir()}`,
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
    });

    this.session.on('permissionResolved', (toolUseId: string) => {
      this.notifications.cancel(`perm:${toolUseId}`);
    });

    this.session.on('sdkMessage', (msg: NormalizedMessage) => this.emit('sdkMessage', msg));

    this.notifications.on('notify', async (events: NotificationEvent[]) => {
      if (!this.imSend || !this.imChatId) return;
      for (const event of events) {
        const text = event.body ? `${event.title}\n${event.body}` : event.title;
        const messageId = await this.imSend(this.imChatId, text, event.buttons);
        if (messageId && event.kind === 'permission_required') {
          this.router.registerTerminalNotification(messageId, this.session.info.sessionId, this.session.info.workdir);
        }
      }
    });

    this.session.on('sessionComplete', () => {
      this.notifications.push({
        kind: 'task_complete', dedupeKey: `complete:${this.session.info.sessionId}`,
        severity: 'info', requiresUserAction: false,
        sessionId: this.session.info.sessionId,
        title: `✅ Session complete · ${this.shortWorkdir()}`,
      });
    });
  }

  async start(): Promise<void> { await this.session.startPTY(); }

  async handleIMAction(action: string, toolUseId: string): Promise<void> {
    if (action === 'takeover') {
      await this.session.handoffToSDK({
        onPermissionRequest: (id, toolName, input) => {
          this.notifications.push({
            kind: 'permission_required', dedupeKey: `perm:${id}`,
            severity: 'warning', requiresUserAction: true,
            sessionId: this.session.info.sessionId,
            title: `⚠️ ${toolName}`,
            body: JSON.stringify(input).slice(0, 200),
            buttons: [
              { label: 'Allow', callbackData: `perm:allow:${id}` },
              { label: 'Deny', callbackData: `perm:deny:${id}`, style: 'danger' as const },
            ],
          });
        },
      });
    } else if (action === 'allow' || action === 'deny') {
      if (this.session.state === 'sdk_active') {
        this.session.resolvePermission(toolUseId, action);
      } else {
        await this.session.handoffToSDK({
          onPermissionRequest: (id) => {
            setTimeout(() => this.session.resolvePermission(id, action as 'allow' | 'deny'), 100);
          },
        });
      }
    }
  }

  async handleTerminalInput(data: string): Promise<void> {
    if (this.session.state === 'sdk_active') {
      await this.session.takebackToTerminal();
    } else {
      this.session.writeToPTY(data);
    }
  }

  async stop(): Promise<void> {
    this.notifications.reset();
    await this.session.stop();
  }

  private shortWorkdir(): string {
    return this.session.info.workdir.split('/').pop() ?? this.session.info.workdir;
  }
}
