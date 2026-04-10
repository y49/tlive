import { BaseChannelAdapter, createAdapter } from '../channels/base.js';
import type { ChannelType, InboundMessage } from '../channels/types.js';
import { ChannelRouter } from './router.js';
import { PermissionBroker } from '../permissions/broker.js';
import { PendingPermissions } from '../permissions/gateway.js';
import { getBridgeContext } from '../context.js';
import { resolveProvider } from '../providers/index.js';
import type { LLMProvider } from '../providers/base.js';
import { loadConfig } from '../config.js';
import { SessionStateManager } from './session-state.js';
import { PermissionCoordinator } from './permission-coordinator.js';
import { CommandRouter } from './command-router.js';
import { CallbackRouter } from './callback-router.js';
import { SDKEngine } from './sdk-engine.js';
import { MessageRouter } from './message-router.js';
import { ControlPanel } from './control-panel.js';
import { networkInterfaces } from 'node:os';
import type { NotificationRenderer } from '../renderers/types.js';
import { TelegramRenderer } from '../renderers/telegram.js';
import { DiscordRenderer } from '../renderers/discord.js';
import { FeishuRenderer } from '../renderers/feishu.js';

/** Bridge commands handled synchronously (don't block adapter loop) */
const QUICK_COMMANDS = new Set(['/menu', '/new', '/status', '/verbose', '/hooks', '/sessions', '/session', '/help', '/perm', '/effort', '/stop', '/approve', '/pairings', '/runtime', '/settings', '/model']);

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  const num = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

/** Detect LAN IP address, matching Go Core's getLocalIP() logic */
function getLocalIP(): string {
  // Prefer iterating interfaces for a private IPv4 address
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal && isPrivateIPv4(info.address)) {
        return info.address;
      }
    }
  }
  return 'localhost';
}

export class BridgeManager {
  private adapters = new Map<string, BaseChannelAdapter>();
  private running = false;
  private router = new ChannelRouter();
  private coreUrl: string;
  private token: string;
  private coreAvailable = false;
  private state = new SessionStateManager();
  private permissions: PermissionCoordinator;
  private renderers: Map<ChannelType, NotificationRenderer>;

  private commands: CommandRouter;
  private callbackRouter: CallbackRouter;
  private sdkEngine: SDKEngine;
  private messageRouter: MessageRouter;
  /** Cached LLM providers keyed by runtime name */
  private providerCache = new Map<string, LLMProvider>();

  constructor() {
    const config = loadConfig();
    const effectivePublicUrl = config.publicUrl || `http://${getLocalIP()}:${config.port || 4590}`;
    const gateway = new PendingPermissions();
    this.renderers = new Map<ChannelType, NotificationRenderer>([
      ['telegram', new TelegramRenderer()],
      ['discord', new DiscordRenderer()],
      ['feishu', new FeishuRenderer()],
    ]);
    const broker = new PermissionBroker(gateway, effectivePublicUrl, this.renderers);
    this.coreUrl = config.coreUrl;
    this.token = config.token;
    this.permissions = new PermissionCoordinator(gateway, broker, this.coreUrl, this.token, this.renderers);
    this.sdkEngine = new SDKEngine(this.state, this.router, this.permissions, this.renderers);
    this.messageRouter = new MessageRouter(
      this.permissions, this.state, this.sdkEngine,
      () => this.coreAvailable, this.coreUrl, this.token,
    );
    this.messageRouter.loadChatIds();
    this.commands = new CommandRouter(
      this.state,
      () => this.adapters,
      this.router,
      () => this.coreAvailable,
      this.sdkEngine.getActiveControls(),
      this.permissions,
      (channelType, chatId) => this.sdkEngine.closeSession(channelType, chatId),
      this.renderers,
    );
    this.callbackRouter = new CallbackRouter(
      this.permissions,
      this.sdkEngine.getQuestionState(),
      () => this.coreAvailable,
      (adapter, msg) => this.handleInboundMessage(adapter, msg),
      this.renderers,
    );

    // Wire control panel into command & callback routers
    const controlPanel = new ControlPanel(
      this.state,
      this.sdkEngine,
      this.sdkEngine.getActiveControls(),
      this.router,
      this.renderers,
      (channelType, chatId) => this.sdkEngine.closeSession(channelType, chatId),
    );
    this.commands.setControlPanel(controlPanel);
    this.callbackRouter.setControlPanel(controlPanel);

    // Wire terminal permission callback through to IPC
    this.callbackRouter.onTerminalPermissionCallback = (action, toolUseId, sessionId) => {
      this.onTerminalPermissionCallback?.(action, toolUseId, sessionId);
    };
    // Wire terminal question callback through to IPC
    this.callbackRouter.onTerminalQuestionCallback = (data) => {
      this.onTerminalQuestionCallback?.(data);
    };
    // Wire session resume callback — saves session data and starts SDK turn
    this.callbackRouter.onResumeSession = (adapter, chatId, sessionId, workdir) => {
      this.resumeSession(adapter, chatId, sessionId, workdir);
    };
  }

  /** Returns all active adapters */
  getAdapters(): BaseChannelAdapter[] {
    return Array.from(this.adapters.values());
  }

  /** Returns the renderer map (for passing to TerminalRelay). */
  getRenderers(): Map<ChannelType, NotificationRenderer> {
    return this.renderers;
  }

  /** Get the last active chatId for a given channel type (for hook routing) */
  getLastChatId(channelType: string): string {
    return this.messageRouter.getLastChatId(channelType);
  }

  /** Resolve LLM provider for a chat — uses per-chat runtime if set, else global default */
  private getProvider(channelType: string, chatId: string): LLMProvider {
    const runtime = this.state.getRuntime(channelType, chatId);
    if (!runtime) return getBridgeContext().llm;

    if (!this.providerCache.has(runtime)) {
      const config = loadConfig();
      this.providerCache.set(runtime, resolveProvider(runtime, this.permissions.getGateway(), {
        claudeSettingSources: config.claudeSettingSources,
      }));
    }
    return this.providerCache.get(runtime)!;
  }

  /** Delegate: track a hook message for reply routing */
  trackHookMessage(messageId: string, sessionId: string): void {
    this.permissions.trackHookMessage(messageId, sessionId);
  }

  /** Delegate: track a permission message for text-based approval */
  trackPermissionMessage(messageId: string, permissionId: string, sessionId: string, channelType: string): void {
    this.permissions.trackPermissionMessage(messageId, permissionId, sessionId, channelType);
  }

  /** Delegate: store original permission card text */
  storeHookPermissionText(hookId: string, text: string): void {
    this.permissions.storeHookPermissionText(hookId, text);
  }

  /** Delegate: store AskUserQuestion data */
  storeQuestionData(hookId: string, questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>, contextSuffix?: string): void {
    this.permissions.storeQuestionData(hookId, questions, contextSuffix);
  }

  /** Callback for forwarding terminal permission actions via IPC */
  onTerminalPermissionCallback?: (action: string, toolUseId: string, sessionId: string) => void;
  /** Callback for forwarding terminal question answers via IPC */
  onTerminalQuestionCallback?: (callbackData: string) => void;
  /** Callback for forwarding effort/model config updates to terminal via IPC */
  onConfigUpdate?: (update: Record<string, unknown>) => void;

  /** Intercept inbound messages — return true to consume (don't route to SDK) */
  onInboundMessage?: (channelType: string, msg: { text: string; replyToMessageId?: string }) => boolean;

  /** Resume a discovered Claude session — store session data and start an SDK turn */
  private async resumeSession(adapter: BaseChannelAdapter, chatId: string, sessionId: string, workdir: string): Promise<void> {
    try {
      const { store } = getBridgeContext();
      const channelType = adapter.channelType;

      // Create a bridge session pointing to the discovered Claude session
      const bridgeSessionId = `resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await store.saveSession({
        id: bridgeSessionId,
        sdkSessionId: sessionId,
        workingDirectory: workdir,
        createdAt: new Date().toISOString(),
      });

      // Bind this chat to the new bridge session
      await this.router.rebind(channelType, chatId, bridgeSessionId);
      this.state.clearThread(channelType, chatId);

      // Send empty turn to attach — the SDK will resume the existing conversation
      const provider = this.getProvider(channelType, chatId);
      await this.sdkEngine.handleMessage(adapter, {
        channelType,
        chatId,
        userId: '',
        text: '',
        messageId: '',
      }, provider);
    } catch (err) {
      console.error(`[tlive:engine] Failed to resume session ${sessionId}:`, err);
      const renderer = this.renderers.get(adapter.channelType)!;
      adapter.sendRendered(chatId, renderer.renderSimpleText(`⚠️ Failed to resume session: ${err}`)).catch(() => {});
    }
  }

  registerAdapter(adapter: BaseChannelAdapter): void {
    this.adapters.set(adapter.channelType, adapter);
  }

  async start(): Promise<void> {
    this.running = true;
    for (const [type, adapter] of this.adapters) {
      const err = adapter.validateConfig();
      if (err) { console.warn(`Skipping ${type}: ${err}`); this.adapters.delete(type); continue; }
      await adapter.start();
      this.runAdapterLoop(adapter);
    }
    this.permissions.startPruning();
    this.sdkEngine.startSessionPruning();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.permissions.stopPruning();
    this.sdkEngine.stopSessionPruning();
    this.permissions.getGateway().denyAll();
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }

  /** Process queued messages iteratively after current turn completes */
  private async drainQueue(adapter: BaseChannelAdapter, channelType: string, chatId: string): Promise<void> {
    let next: InboundMessage | undefined;
    while ((next = this.sdkEngine.dequeueMessage(channelType, chatId))) {
      console.log(`[${adapter.channelType}] Processing queued message`);
      try {
        await this.handleInboundMessage(adapter, next);
      } catch (err) {
        console.error(`[${adapter.channelType}] Error processing queued message:`, err);
        break;
      }
    }
  }

  /** Wait briefly for follow-up messages from the same user, merge text if they arrive quickly.
   *  Handles Telegram splitting long messages at 4096 chars. */
  /** Telegram message length limit — only coalesce if text is near this boundary */
  private static TG_MSG_LIMIT = 4096;

  private async coalesceMessages(adapter: BaseChannelAdapter, first: InboundMessage): Promise<InboundMessage> {
    if (!first.text || first.callbackData) return first;

    // Only wait for follow-up parts if message is near Telegram's 4096 char limit
    if (first.text.length < BridgeManager.TG_MSG_LIMIT - 200) return first;

    // Wait up to 500ms for follow-up parts
    const parts: string[] = [first.text];
    const deadline = Date.now() + 500;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
      const next = await adapter.consumeOne();
      if (!next) continue;

      // Only merge if same user, same chat, text-only (no callback/command), arrives quickly
      if (next.userId === first.userId && next.chatId === first.chatId
          && next.text && !next.callbackData && !next.text.startsWith('/')) {
        parts.push(next.text);
        console.log(`[${adapter.channelType}] Coalesced message part (${next.text.length} chars)`);
      } else {
        // Different message — put it back by re-processing later
        // We can't "unget" so we handle it inline
        // For simplicity, process it in the next loop iteration by pushing to a buffer
        this.coalescePushback.set(adapter.channelType, next);
        break;
      }
    }

    if (parts.length === 1) return first;
    console.log(`[${adapter.channelType}] Merged ${parts.length} message parts (${parts.reduce((s, p) => s + p.length, 0)} chars total)`);
    return { ...first, text: parts.join('\n') };
  }

  private coalescePushback = new Map<string, InboundMessage>();

  private async runAdapterLoop(adapter: BaseChannelAdapter): Promise<void> {
    while (this.running) {
      // Check pushback from coalescing first
      let msg = this.coalescePushback.get(adapter.channelType) ?? await adapter.consumeOne();
      this.coalescePushback.delete(adapter.channelType);
      if (!msg) { await new Promise(r => setTimeout(r, 100)); continue; }
      console.log(`[${adapter.channelType}] Message from ${msg.userId}: ${msg.text || '(callback)'}`);
      // Callbacks, commands, and permission text are fast — await them.
      // Regular messages (Claude queries) are fire-and-forget so they don't
      // block the loop while waiting for LLM responses or permission approvals.
      const hasPendingQuestion = this.permissions.getLatestPendingQuestion(adapter.channelType) !== null
        || this.sdkEngine.findPendingQuestion(adapter.channelType, msg.chatId) !== null;
      const isQuickMessage = !!msg.callbackData
        || (msg.text && QUICK_COMMANDS.has(msg.text.split(' ')[0].toLowerCase()))
        || this.permissions.parsePermissionText(msg.text || '') !== null
        || hasPendingQuestion;
      if (isQuickMessage) {
        try {
          await this.handleInboundMessage(adapter, msg);
        } catch (err) {
          console.error(`[${adapter.channelType}] Error handling message:`, err);
        }
      } else {
        // Coalesce rapid-fire messages (e.g. Telegram splits long text at 4096 chars)
        // Wait briefly and merge any follow-up messages from the same user/chat
        const coalesced = await this.coalesceMessages(adapter, msg);

        // Guard: if this chat is already processing a message
        const chatKey = this.state.stateKey(coalesced.channelType, coalesced.chatId);
        if (this.state.isProcessing(chatKey)) {
          const renderer = this.renderers.get(adapter.channelType)!;
          if (coalesced.text && this.sdkEngine.canSteer(coalesced.channelType, coalesced.chatId, coalesced.replyToMessageId)) {
            this.sdkEngine.steer(coalesced.channelType, coalesced.chatId, coalesced.text);
            await adapter.sendRendered(coalesced.chatId, renderer.renderSimpleText('💬 Message sent to active session')).catch(() => {});
          } else if (coalesced.text) {
            const queued = this.sdkEngine.queueMessage(coalesced.channelType, coalesced.chatId, coalesced);
            if (queued) {
              await adapter.sendRendered(coalesced.chatId, renderer.renderSimpleText('📥 Queued — will process after current task')).catch(() => {});
            } else {
              await adapter.sendRendered(coalesced.chatId, renderer.renderSimpleText('⚠️ Queue full — please wait for current tasks to finish')).catch(() => {});
            }
          }
          continue;
        }
        this.state.setProcessing(chatKey, true);
        this.handleInboundMessage(adapter, coalesced)
          .then(() => this.drainQueue(adapter, coalesced.channelType, coalesced.chatId))
          .catch(err => console.error(`[${adapter.channelType}] Error handling message:`, err))
          .finally(() => this.state.setProcessing(chatKey, false));
      }
    }
  }

  async handleInboundMessage(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    // Check if this message should be forwarded to a terminal session via IPC
    if (msg.text && this.onInboundMessage?.(adapter.channelType, {
      text: msg.text,
      replyToMessageId: msg.replyToMessageId,
    })) {
      return true; // consumed by terminal relay
    }

    // Text routing: auth, attachments, permissions, AskQuestion replies, hook replies
    const result = await this.messageRouter.route(adapter, msg);
    if (result.action === 'handled') return true;
    if (result.action === 'unauthorized') return false;

    // Callback data — delegate to CallbackRouter
    if (msg.callbackData) {
      return this.callbackRouter.handle(adapter, msg);
    }

    // Bridge commands — only intercept known commands, pass others to Claude Code
    if (msg.text?.startsWith('/')) {
      const handled = await this.commands.handle(adapter, msg);
      if (handled) return true;

      // Unrecognized slash command — check if provider supports passthrough
      const provider = this.getProvider(msg.channelType, msg.chatId);
      if (!provider.capabilities().slashCommands) {
        const renderer = this.renderers.get(adapter.channelType)!;
        await adapter.sendRendered(msg.chatId, renderer.renderSimpleText('⚠️ Slash commands not supported by current runtime'));
        return true;
      }
    }

    // SDK conversation — delegate to SDKEngine
    return this.sdkEngine.handleMessage(adapter, msg, this.getProvider(msg.channelType, msg.chatId));
  }

}
