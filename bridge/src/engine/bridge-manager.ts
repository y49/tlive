import { BaseChannelAdapter, createAdapter } from '../channels/base.js';
import type { InboundMessage, OutboundMessage } from '../channels/types.js';
import { ConversationEngine } from './conversation.js';
import { ChannelRouter } from './router.js';
import { PermissionBroker } from '../permissions/broker.js';
import { PendingPermissions } from '../permissions/gateway.js';
import { DeliveryLayer, chunkByParagraph } from '../delivery/delivery.js';
import { getBridgeContext } from '../context.js';
import { resolveProvider } from '../providers/index.js';
import type { LLMProvider } from '../providers/base.js';
import { loadConfig } from '../config.js';
import { markdownToTelegram } from '../markdown/index.js';
import { downgradeHeadings } from '../markdown/feishu.js';
import { MessageRenderer } from './message-renderer.js';
import { getToolCommand } from './tool-registry.js';
import { SessionStateManager } from './session-state.js';
import { PermissionCoordinator } from './permission-coordinator.js';
import { CommandRouter } from './command-router.js';
import type { FeishuStreamingSession } from '../channels/feishu-streaming.js';
import { CostTracker } from './cost-tracker.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';

/** Bridge commands handled synchronously (don't block adapter loop) */
const QUICK_COMMANDS = new Set(['/new', '/status', '/verbose', '/hooks', '/sessions', '/session', '/help', '/perm', '/effort', '/stop', '/approve', '/pairings', '/runtime', '/settings', '/model']);

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

/** Data shape for hook notifications (stop, idle_prompt, etc.) from Go Core */
export interface HookNotificationData {
  tlive_hook_type?: string;
  tlive_session_id?: string;
  tlive_cwd?: string;
  notification_type?: string;
  message?: string;
  last_assistant_message?: string;
  last_output?: string;
  [key: string]: unknown;
}

export class BridgeManager {
  private adapters = new Map<string, BaseChannelAdapter>();
  private running = false;
  private engine = new ConversationEngine();
  private router = new ChannelRouter();
  private delivery = new DeliveryLayer();
  private coreUrl: string;
  private token: string;
  private coreAvailable = false;
  private state = new SessionStateManager();
  private permissions: PermissionCoordinator;
  /** Active query controls per chat — for /stop command */
  private activeControls = new Map<string, import('../providers/base.js').QueryControls>();
  private lastChatId = new Map<string, string>();
  /** Pending image attachments waiting for a text message to merge with (key: channelType:chatId) */
  private pendingAttachments = new Map<string, { attachments: import('../channels/types.js').FileAttachment[]; timestamp: number }>();

  private commands: CommandRouter;
  private chatIdFile: string;
  /** Cached LLM providers keyed by runtime name */
  private providerCache = new Map<string, LLMProvider>();
  /** SDK AskUserQuestion: store question data and selected option index */
  private sdkQuestionData = new Map<string, { questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }> }>();
  private sdkQuestionAnswers = new Map<string, number>();
  private sdkQuestionTextAnswers = new Map<string, string>();

  constructor() {
    const config = loadConfig();
    const effectivePublicUrl = config.publicUrl || `http://${getLocalIP()}:${config.port || 8080}`;
    const gateway = new PendingPermissions();
    const broker = new PermissionBroker(gateway, effectivePublicUrl);
    this.coreUrl = config.coreUrl;
    this.token = config.token;
    this.permissions = new PermissionCoordinator(gateway, broker, this.coreUrl, this.token);
    // Load persisted chatIds (so hook routing works without needing a message first)
    this.chatIdFile = join(homedir(), '.tlive', 'runtime', 'chat-ids.json');
    try {
      const data = JSON.parse(readFileSync(this.chatIdFile, 'utf-8'));
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string') this.lastChatId.set(k, v);
      }
    } catch { /* no saved chat IDs yet */ }
    this.commands = new CommandRouter(
      this.state,
      () => this.adapters,
      this.router,
      () => this.coreAvailable,
      this.activeControls,
      this.permissions,
    );
  }

  /** Expose coreAvailable flag for main.ts polling loop */
  setCoreAvailable(available: boolean): void {
    this.coreAvailable = available;
  }

  /** Returns all active adapters */
  getAdapters(): BaseChannelAdapter[] {
    return Array.from(this.adapters.values());
  }

  /** Get the last active chatId for a given channel type (for hook routing) */
  getLastChatId(channelType: string): string {
    return this.lastChatId.get(channelType) ?? '';
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
  storeQuestionData(hookId: string, questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>): void {
    this.permissions.storeQuestionData(hookId, questions);
  }

  /** Find a pending SDK AskUserQuestion for numeric text reply */
  private findPendingSdkQuestion(_channelType: string, _chatId: string): { permId: string } | null {
    // Find the most recent pending SDK askq permission
    for (const [permId] of this.sdkQuestionData) {
      if (this.permissions.getGateway().isPending(permId)) {
        return { permId };
      }
    }
    return null;
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
  }

  async stop(): Promise<void> {
    this.running = false;
    this.permissions.stopPruning();
    this.permissions.getGateway().denyAll();
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }

  /** Send a hook notification to IM with [Local] prefix and track for reply routing */
  async sendHookNotification(adapter: BaseChannelAdapter, chatId: string, hook: HookNotificationData, receiveIdType?: string): Promise<void> {
    const { formatNotification } = await import('../formatting/index.js');
    const hookType = hook.tlive_hook_type || '';

    let title: string;
    let type: 'stop' | 'idle_prompt' | 'generic';
    let summary: string | undefined;

    // Build context suffix: project name + short session ID
    const contextParts: string[] = [];
    if (hook.tlive_cwd) {
      const projectName = basename(hook.tlive_cwd || '') || '';
      if (projectName) contextParts.push(projectName);
    }
    if (hook.tlive_session_id) {
      const shortId = hook.tlive_session_id.slice(-6);
      contextParts.push(`#${shortId}`);
    }
    const contextSuffix = contextParts.length > 0 ? ' · ' + contextParts.join(' · ') : '';

    if (hookType === 'stop') {
      type = 'stop';
      const raw = (hook.last_assistant_message || hook.last_output || '').trim();
      summary = raw ? (raw.length > 3000 ? raw.slice(0, 2997) + '...' : raw) : undefined;
      title = `Terminal${contextSuffix}`;
    } else if (hook.notification_type === 'idle_prompt') {
      title = `Terminal${contextSuffix} · ` + (hook.message || 'Waiting for input...');
      type = 'idle_prompt';
    } else {
      title = hook.message || 'Notification';
      type = 'generic';
    }

    let terminalUrl: string | undefined;
    if (this.coreAvailable && hook.tlive_session_id) {
      const config = loadConfig();
      const baseUrl = config.publicUrl || `http://${getLocalIP()}:${config.port || 8080}`;
      terminalUrl = `${baseUrl}/terminal.html?id=${hook.tlive_session_id}&token=${this.token}`;
    }

    const formatted = formatNotification({ type, title, summary, terminalUrl }, adapter.channelType as any);

    const outMsg: import('../channels/types.js').OutboundMessage = {
      chatId,
      text: formatted.text,
      html: formatted.html,
      embed: formatted.embed,
      buttons: (formatted as any).buttons,
      feishuHeader: formatted.feishuHeader,
      feishuElements: (formatted as any).feishuElements,
      receiveIdType,
    };
    const result = await adapter.send(outMsg);
    this.permissions.trackHookMessage(result.messageId, hook.tlive_session_id || '');
  }

  private async runAdapterLoop(adapter: BaseChannelAdapter): Promise<void> {
    while (this.running) {
      const msg = await adapter.consumeOne();
      if (!msg) { await new Promise(r => setTimeout(r, 100)); continue; }
      console.log(`[${adapter.channelType}] Message from ${msg.userId}: ${msg.text || '(callback)'}`);
      // Callbacks, commands, and permission text are fast — await them.
      // Regular messages (Claude queries) are fire-and-forget so they don't
      // block the loop while waiting for LLM responses or permission approvals.
      const hasPendingQuestion = this.permissions.getLatestPendingQuestion(adapter.channelType) !== null
        || this.findPendingSdkQuestion(adapter.channelType, msg.chatId) !== null;
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
        // Guard: if this chat is already processing a message, tell the user
        const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
        if (this.state.isProcessing(chatKey)) {
          await adapter.send({ chatId: msg.chatId, text: '⏳ Previous message still processing, please wait...' }).catch(() => {});
          continue;
        }
        this.state.setProcessing(chatKey, true);
        this.handleInboundMessage(adapter, msg)
          .catch(err => console.error(`[${adapter.channelType}] Error handling message:`, err))
          .finally(() => this.state.setProcessing(chatKey, false));
      }
    }
  }

  async handleInboundMessage(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    // Auth check — with pairing mode for Telegram
    if (!adapter.isAuthorized(msg.userId, msg.chatId)) {
      // Telegram pairing mode: generate code for unknown user (DM only)
      if (adapter.channelType === 'telegram' && 'requestPairing' in adapter && msg.text) {
        const tgAdapter = adapter as any;
        const username = msg.userId; // userId as fallback
        const code = tgAdapter.requestPairing(msg.userId, msg.chatId, username);
        if (code) {
          await adapter.send({
            chatId: msg.chatId,
            html: [
              `🔐 <b>Pairing Required</b>`,
              '',
              `Your pairing code: <code>${code}</code>`,
              '',
              `Ask an admin to run <code>/approve ${code}</code> in an authorized channel.`,
              `Code expires in 1 hour.`,
            ].join('\n'),
          });
        }
      }
      return false;
    }

    // Track last active chatId per channel type (used for hook notification routing)
    if (msg.chatId) {
      this.lastChatId.set(adapter.channelType, msg.chatId);
      // Persist so hooks work even after Bridge restart
      try {
        mkdirSync(join(homedir(), '.tlive', 'runtime'), { recursive: true });
        writeFileSync(this.chatIdFile, JSON.stringify(Object.fromEntries(this.lastChatId)));
      } catch { /* non-fatal */ }
    }

    // Image buffering: cache image-only messages, merge into next text message
    const attachKey = `${msg.channelType}:${msg.chatId}`;
    if (msg.attachments?.length && !msg.text && !msg.callbackData) {
      // Image-only message: buffer attachments and wait for text
      // Limit: max 5 attachments, max 10MB total
      const MAX_ATTACHMENTS = 5;
      const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
      let attachments = msg.attachments.slice(0, MAX_ATTACHMENTS);
      const totalBytes = attachments.reduce((sum, a) => sum + a.base64Data.length, 0);
      if (totalBytes > MAX_TOTAL_BYTES) {
        // Keep only attachments that fit within budget
        let budget = MAX_TOTAL_BYTES;
        attachments = attachments.filter(a => {
          if (a.base64Data.length <= budget) {
            budget -= a.base64Data.length;
            return true;
          }
          return false;
        });
        console.warn(`[${msg.channelType}] Attachment buffer exceeded 10MB limit, kept ${attachments.length}`);
      }
      if (attachments.length > 0) {
        this.pendingAttachments.set(attachKey, {
          attachments,
          timestamp: Date.now(),
        });
        console.log(`[${msg.channelType}] Buffered ${attachments.length} attachment(s), waiting for text`);
      }
      return true;
    }
    // Merge pending attachments into current text message
    if (msg.text && !msg.callbackData) {
      const pending = this.pendingAttachments.get(attachKey);
      if (pending && Date.now() - pending.timestamp < 60_000) {
        msg.attachments = [...(msg.attachments || []), ...pending.attachments];
        console.log(`[${msg.channelType}] Merged ${pending.attachments.length} buffered attachment(s) with text`);
      }
      this.pendingAttachments.delete(attachKey);
    }

    // Text-based permission resolution (all platforms — fallback when buttons expire)
    if (msg.text) {
      const decision = this.permissions.parsePermissionText(msg.text);
      if (decision) {
        // 1. Try SDK permission gateway — scoped to THIS chat only
        const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
        if (this.permissions.tryResolveByText(chatKey, decision)) {
          // Brief reaction instead of a full card — avoids flooding
          const emoji = decision === 'deny' ? 'NO' : decision === 'allow_always' ? 'DONE' : 'OK';
          adapter.addReaction(msg.chatId, msg.messageId, emoji).catch(() => {});
          return true;
        }

        // 2. Try hook permission (via Go Core)
        if (this.permissions.pendingPermissionCount() > 1 && !msg.replyToMessageId) {
          const hint = adapter.channelType === 'feishu'
            ? '⚠️ 多个权限待审批，请引用回复具体的权限消息'
            : '⚠️ Multiple permissions pending — reply to the specific permission message';
          await adapter.send({ chatId: msg.chatId, text: hint });
          return true;
        }
        const permEntry = this.permissions.findHookPermission(msg.replyToMessageId, adapter.channelType);
        if (permEntry && this.coreAvailable) {
          try {
            await this.permissions.resolveHookPermission(permEntry.permissionId, decision, adapter.channelType, this.coreAvailable);
            const label = decision === 'deny' ? '❌ Denied' : decision === 'allow_always' ? '📌 Always allowed' : '✅ Allowed';
            await adapter.send({ chatId: msg.chatId, text: label });
          } catch (err) {
            await adapter.send({ chatId: msg.chatId, text: `❌ Failed to resolve: ${err}` });
          }
          return true;
        }
      }
    }

    // Text reply to pending AskUserQuestion — numeric (select option) or free text (direct input)
    if (msg.text) {
      const trimmed = msg.text.trim();
      // Check for any pending AskUserQuestion (hook or SDK mode)
      const pendingHookQ = this.permissions.getLatestPendingQuestion(adapter.channelType);
      const pendingSdkQ = this.findPendingSdkQuestion(adapter.channelType, msg.chatId);

      if (pendingHookQ || pendingSdkQ) {
        const numMatch = trimmed.match(/^(\d+)$/);
        if (numMatch) {
          // Numeric reply — select option by index
          const optionIndex = parseInt(numMatch[1], 10) - 1;
          if (optionIndex >= 0) {
            if (pendingHookQ) {
              await this.permissions.resolveAskQuestion(
                pendingHookQ.hookId, optionIndex, pendingHookQ.sessionId,
                pendingHookQ.messageId, adapter, msg.chatId, this.coreAvailable,
              );
              return true;
            }
            if (pendingSdkQ) {
              this.sdkQuestionAnswers.set(pendingSdkQ.permId, optionIndex);
              this.permissions.getGateway().resolve(pendingSdkQ.permId, 'allow');
              return true;
            }
          }
        } else {
          // Free text reply — use text as direct answer
          if (pendingHookQ) {
            await this.permissions.resolveAskQuestionWithText(
              pendingHookQ.hookId, trimmed, pendingHookQ.sessionId,
              pendingHookQ.messageId, adapter, msg.chatId, this.coreAvailable,
            );
            return true;
          }
          if (pendingSdkQ) {
            this.sdkQuestionTextAnswers.set(pendingSdkQ.permId, trimmed);
            this.permissions.getGateway().resolve(pendingSdkQ.permId, 'allow');
            return true;
          }
        }
      }
    }

    // Reply routing: quote-reply to a hook message → send to PTY stdin
    if ((msg.text || msg.attachments?.length) && msg.replyToMessageId && this.permissions.isHookMessage(msg.replyToMessageId)) {
      const entry = this.permissions.getHookMessage(msg.replyToMessageId)!;
      if (entry.sessionId && this.coreAvailable) {
        try {
          // If images attached, save as temp files and include paths in the text
          let inputText = msg.text || '';
          if (msg.attachments?.length) {
            const { writeFileSync, mkdirSync } = await import('node:fs');
            const { join } = await import('node:path');
            const { tmpdir } = await import('node:os');
            const imgDir = join(tmpdir(), 'tlive-images');
            mkdirSync(imgDir, { recursive: true });
            for (const att of msg.attachments) {
              if (att.type === 'image') {
                const ext = att.mimeType === 'image/png' ? '.png' : '.jpg';
                const filePath = join(imgDir, `img-${Date.now()}${ext}`);
                writeFileSync(filePath, Buffer.from(att.base64Data, 'base64'));
                inputText = inputText ? `${inputText}\n${filePath}` : filePath;
              }
            }
          }
          await fetch(`${this.coreUrl}/api/sessions/${entry.sessionId}/input`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: inputText + '\r' }),
            signal: AbortSignal.timeout(5000),
          });
          await adapter.send({ chatId: msg.chatId, text: '✓ Sent to local session' });
        } catch (err) {
          await adapter.send({ chatId: msg.chatId, text: `❌ Failed to send: ${err}` });
        }
      } else {
        await adapter.send({ chatId: msg.chatId, text: '⚠️ Local session not available (no session ID)' });
      }
      return true;
    }

    // Callback data
    if (msg.callbackData) {
      // Prompt suggestion callback — re-inject as a normal user message
      if (msg.callbackData.startsWith('suggest:')) {
        const suggestion = msg.callbackData.slice('suggest:'.length);
        // Re-process as a regular text message
        msg.text = suggestion;
        msg.callbackData = undefined;
        return this.handleInboundMessage(adapter, msg);
      }

      // AskUserQuestion answer callbacks (askq:{hookId}:{optionIndex}:{sessionId})
      if (msg.callbackData.startsWith('askq:')) {
        const parts = msg.callbackData.split(':');
        const hookId = parts[1];
        const optionIndex = parseInt(parts[2], 10);
        const sessionId = parts[3] || '';
        await this.permissions.resolveAskQuestion(
          hookId, optionIndex, sessionId,
          msg.messageId, adapter, msg.chatId, this.coreAvailable,
        );
        return true;
      }

      // AskUserQuestion skip callback — resolve with allow + empty answers (askq_skip:{hookId}:{sessionId})
      if (msg.callbackData.startsWith('askq_skip:')) {
        const parts = msg.callbackData.split(':');
        const hookId = parts[1];
        const sessionId = parts[2] || '';
        await this.permissions.resolveAskQuestionSkip(
          hookId, sessionId,
          msg.messageId, adapter, msg.chatId, this.coreAvailable,
        );
        return true;
      }

      // Hook permission callbacks (hook:allow:ID:sessionId, hook:allow_always:ID:sessionId, hook:deny:ID:sessionId)
      if (msg.callbackData.startsWith('hook:')) {
        const parts = msg.callbackData.split(':');
        const decision = parts[1]; // allow, allow_always, or deny
        const hookId = parts[2];
        const sessionId = parts[3] || '';
        await this.permissions.resolveHookCallback(hookId, decision, sessionId, msg.messageId, adapter, msg.chatId, this.coreAvailable);
        return true;
      }

      // Graduated permission callbacks — resolve gateway, no message edit
      // (renderer.onPermissionResolved() handles the visual transition)
      if (msg.callbackData.startsWith('perm:allow_edits:')) {
        const permId = msg.callbackData.split(':').slice(2).join(':');
        this.permissions.getGateway().resolve(permId, 'allow');
        return true;
      }

      if (msg.callbackData.startsWith('perm:allow_tool:')) {
        const parts = msg.callbackData.split(':');
        const permId = parts[2];
        const toolName = parts.slice(3).join(':');
        this.permissions.getGateway().resolve(permId, 'allow');
        this.permissions.addAllowedTool(toolName);
        console.log(`[bridge] Added ${toolName} to session whitelist`);
        return true;
      }

      if (msg.callbackData.startsWith('perm:allow_bash:')) {
        const parts = msg.callbackData.split(':');
        const permId = parts[2];
        const prefix = parts.slice(3).join(':');
        this.permissions.getGateway().resolve(permId, 'allow');
        this.permissions.addAllowedBashPrefix(prefix);
        console.log(`[bridge] Added Bash(${prefix} *) to session whitelist`);
        return true;
      }

      // SDK AskUserQuestion answer callbacks (perm:allow:permId:askq:optionIndex)
      if (msg.callbackData.includes(':askq:')) {
        const parts = msg.callbackData.split(':');
        const askqIdx = parts.indexOf('askq');
        if (askqIdx >= 0) {
          const permId = parts.slice(2, askqIdx).join(':');
          const optionIndex = parseInt(parts[askqIdx + 1], 10);
          const qData = this.sdkQuestionData.get(permId);
          const selected = qData?.questions?.[0]?.options?.[optionIndex];
          this.sdkQuestionAnswers.set(permId, optionIndex);
          this.permissions.getGateway().resolve(permId, 'allow');
          if (selected) {
            adapter.editMessage(msg.chatId, msg.messageId, {
              chatId: msg.chatId,
              text: `✅ Selected: ${selected.label}`,
              feishuHeader: { template: 'green', title: `✅ ${selected.label}` },
            }).catch(() => {});
          }
          return true;
        }
      }

      // SDK AskUserQuestion skip (perm:allow:permId:askq_skip) — resolve with allow + empty answers
      if (msg.callbackData.includes(':askq_skip')) {
        const parts = msg.callbackData.split(':');
        const skipIdx = parts.indexOf('askq_skip');
        if (skipIdx >= 0) {
          const permId = parts.slice(2, skipIdx).join(':');
          // Mark as skip so sdkAskQuestionHandler returns empty answers
          this.sdkQuestionTextAnswers.set(permId, '');
          this.permissions.getGateway().resolve(permId, 'allow');
          adapter.editMessage(msg.chatId, msg.messageId, {
            chatId: msg.chatId,
            text: '⏭ Skipped',
            buttons: [],
            feishuHeader: { template: 'grey', title: '⏭ Skipped' },
          }).catch(() => {});
          return true;
        }
      }

      // Regular permission broker callbacks (perm:allow:ID, perm:deny:ID)
      console.log(`[bridge] Perm callback: ${msg.callbackData}, gateway pending: ${this.permissions.getGateway().pendingCount()}`);
      this.permissions.handleBrokerCallback(msg.callbackData);
      // No message edit — renderer.onPermissionResolved() morphs back to status line
      return true;
    }

    // Bridge commands — only intercept known commands, pass others to Claude Code
    if (msg.text.startsWith('/')) {
      const handled = await this.commands.handle(adapter, msg);
      if (handled) return true;
      // Unrecognized slash command → fall through to Claude Code
    }

    // Check for session expiry (>30 min inactivity) and auto-create new session
    const expired = this.state.checkAndUpdateLastActive(msg.channelType, msg.chatId);
    if (expired) {
      const newSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await this.router.rebind(msg.channelType, msg.chatId, newSessionId);
      this.state.clearThread(msg.channelType, msg.chatId);
      this.permissions.clearSessionWhitelist();
    }

    const binding = await this.router.resolve(msg.channelType, msg.chatId);

    // Resolve threadId: use existing thread if message came from one, or reuse session thread
    let threadId = msg.threadId;
    if (!threadId && adapter.channelType === 'discord') {
      threadId = this.state.getThread(msg.channelType, msg.chatId);
    }
    // For Telegram topics, always pass threadId through
    if (!threadId && msg.threadId) {
      threadId = msg.threadId;
    }

    // Reaction target: for Discord threads, reaction goes on the original channel message
    const reactionChatId = msg.chatId;

    // Start typing heartbeat (in thread if available)
    const typingTarget = threadId && adapter.channelType === 'discord' ? threadId : msg.chatId;
    const typingInterval = setInterval(() => {
      adapter.sendTyping(typingTarget).catch(() => {});
    }, 4000);
    adapter.sendTyping(typingTarget).catch(() => {});

    const costTracker = new CostTracker();
    costTracker.start();

    // Add processing reaction
    const reactionEmojis: Record<string, { processing: string; done: string; error: string }> = {
      telegram: { processing: '\u{1F914}', done: '\u{1F44D}', error: '\u{1F631}' },
      feishu: { processing: 'Typing', done: 'OK', error: 'FACEPALM' },
      discord: { processing: '\u{1F914}', done: '\u{1F44D}', error: '\u{274C}' },
    };
    const reactions = reactionEmojis[adapter.channelType] || reactionEmojis.telegram;
    adapter.addReaction(reactionChatId, msg.messageId, reactions.processing).catch(() => {});

    // Feishu streaming disabled — new renderer uses short status lines
    // that don't benefit from streaming, and streaming cards can't be
    // edited with im.message.patch (needed for permission buttons)
    let feishuSession: import('../channels/feishu-streaming.js').FeishuStreamingSession | null = null;

    const platformLimits: Record<string, number> = { telegram: 4096, discord: 2000, feishu: 30000 };
    let permissionReminderMsgId: string | undefined;
    let permissionReminderTool: string | undefined;
    let permissionReminderInput: string | undefined;
    const renderer = new MessageRenderer({
      platformLimit: platformLimits[adapter.channelType] ?? 4096,
      throttleMs: 300,
      onPermissionTimeout: async (toolName, input, buttons) => {
        permissionReminderTool = toolName;
        permissionReminderInput = input;
        const text = `⚠️ Permission pending — ${toolName}: ${permissionReminderInput}`;
        const targetChatId = threadId && adapter.channelType === 'discord' ? threadId : msg.chatId;
        const outMsg: OutboundMessage = adapter.channelType === 'telegram'
          ? { chatId: targetChatId, html: markdownToTelegram(text) }
          : { chatId: targetChatId, text };
        outMsg.buttons = buttons.map(b => ({ ...b, style: b.style as 'primary' | 'danger' | 'default' }));
        if (threadId) outMsg.threadId = threadId;
        try {
          const result = await adapter.send(outMsg);
          permissionReminderMsgId = result.messageId;
        } catch { /* non-fatal */ }
      },
      flushCallback: async (content, isEdit, buttons) => {
        // Feishu streaming path — skip when buttons needed (streaming doesn't support buttons)
        if (feishuSession && !buttons?.length) {
          if (!isEdit) {
            try {
              const messageId = await feishuSession.start(downgradeHeadings(content));
              clearInterval(typingInterval);
              return messageId;
            } catch {
              feishuSession = null;
            }
          } else {
            feishuSession.update(downgradeHeadings(content)).catch(() => {});
            return;
          }
        }
        // Non-streaming path
        let outMsg: OutboundMessage;
        if (adapter.channelType === 'telegram') {
          outMsg = { chatId: msg.chatId, html: markdownToTelegram(content), threadId };
        } else if (adapter.channelType === 'discord') {
          outMsg = { chatId: msg.chatId, text: content, threadId };
        } else {
          outMsg = { chatId: msg.chatId, text: content };
        }
        if (buttons?.length) {
          outMsg.buttons = buttons.map(b => ({ ...b, style: b.style as 'primary' | 'danger' | 'default' }));
        }
        if (!isEdit) {
          if (adapter.channelType === 'discord' && !threadId && 'createThread' in adapter) {
            const result = await adapter.send(outMsg);
            clearInterval(typingInterval);
            const preview = (msg.text || 'Claude').slice(0, 80);
            const newThreadId = await (adapter as any).createThread(msg.chatId, result.messageId, `💬 ${preview}`);
            if (newThreadId) {
              threadId = newThreadId;
              this.state.setThread(msg.channelType, msg.chatId, newThreadId);
            }
            return result.messageId;
          }
          const result = await adapter.send(outMsg);
          clearInterval(typingInterval);
          return result.messageId;
        } else {
          const limit = platformLimits[adapter.channelType] ?? 4096;
          if (content.length > limit) {
            // Overflow: edit first chunk into existing message, send rest as new messages
            const chunks = chunkByParagraph(content, limit);
            const firstOutMsg: OutboundMessage = adapter.channelType === 'telegram'
              ? { chatId: msg.chatId, html: markdownToTelegram(chunks[0]), threadId }
              : adapter.channelType === 'discord'
                ? { chatId: msg.chatId, text: chunks[0], threadId }
                : { chatId: msg.chatId, text: chunks[0] };
            await adapter.editMessage(msg.chatId, renderer.messageId!, firstOutMsg);
            const target = threadId && adapter.channelType === 'discord' ? threadId : msg.chatId;
            for (let i = 1; i < chunks.length; i++) {
              const overflowMsg: OutboundMessage = adapter.channelType === 'telegram'
                ? { chatId: target, html: markdownToTelegram(chunks[i]) }
                : { chatId: target, text: chunks[i] };
              await adapter.send(overflowMsg);
            }
          } else {
            await adapter.editMessage(msg.chatId, renderer.messageId!, outMsg);
          }
        }
      },
    });

    let completedStats: import('./cost-tracker.js').UsageStats | undefined;

    // When an AskUserQuestion is approved, auto-allow the next permission request
    // to avoid redundant confirmation (e.g. "delete this?" → yes → Bash permission)
    let askQuestionApproved = false;

    // Build SDK-level permission handler based on /perm mode
    const permMode = this.state.getPermMode(msg.channelType, msg.chatId);
    const sdkPermissionHandler = permMode === 'on'
      ? async (toolName: string, toolInput: Record<string, unknown>, promptSentence: string, signal?: AbortSignal) => {
          // Check dynamic whitelist — auto-allow if previously approved
          if (this.permissions.isToolAllowed(toolName, toolInput)) {
            console.log(`[bridge] Auto-allowed ${toolName} via session whitelist`);
            return 'allow' as const;
          }

          // Auto-allow if user just approved an AskUserQuestion
          if (askQuestionApproved) {
            askQuestionApproved = false;
            console.log(`[bridge] Auto-allowed ${toolName} after AskUserQuestion approval`);
            return 'allow' as const;
          }

          const permId = `sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
          this.permissions.setPendingSdkPerm(chatKey, permId);
          console.log(`[bridge] Permission request: ${toolName} (${permId}) for ${chatKey}`);

          // If SDK aborts (subagent stopped), clean up gateway entry and remove from queue
          const abortCleanup = () => {
            console.log(`[bridge] Permission cancelled by SDK: ${toolName} (${permId})`);
            this.permissions.getGateway().resolve(permId, 'deny', 'Cancelled by SDK');
            this.permissions.clearPendingSdkPerm(chatKey);
            renderer.onPermissionResolved(permId);
          };
          if (signal?.aborted) { abortCleanup(); return 'deny' as const; }
          signal?.addEventListener('abort', abortCleanup, { once: true });

          // Render permission inline in the terminal card
          const inputStr = getToolCommand(toolName, toolInput)
            || JSON.stringify(toolInput, null, 2);
          const buttons: Array<{ label: string; callbackData: string; style: string }> = [
            { label: '✅ Allow', callbackData: `perm:allow:${permId}`, style: 'primary' },
            { label: '❌ Deny', callbackData: `perm:deny:${permId}`, style: 'danger' },
          ];
          renderer.onPermissionNeeded(toolName, inputStr, permId, buttons);

          // Wait for user response (5 min timeout)
          const result = await this.permissions.getGateway().waitFor(permId, {
            timeoutMs: 5 * 60 * 1000,
            onTimeout: () => {
              this.permissions.clearPendingSdkPerm(chatKey);
              console.warn(`[bridge] Permission timeout: ${toolName} (${permId})`);
            },
          });
          signal?.removeEventListener('abort', abortCleanup);
          renderer.onPermissionResolved(permId);

          // Update timeout reminder message if it was sent
          if (permissionReminderMsgId) {
            const icon = result.behavior === 'deny' ? '❌' : '✅';
            const label = `${permissionReminderTool}: ${permissionReminderInput} ${icon}`;
            adapter.editMessage(msg.chatId, permissionReminderMsgId, {
              chatId: msg.chatId,
              text: label,
            }).catch(() => {});
            permissionReminderMsgId = undefined;
          }

          this.permissions.clearPendingSdkPerm(chatKey);
          console.log(`[bridge] Permission resolved: ${toolName} (${permId}) → ${result.behavior}`);
          return result.behavior as 'allow' | 'allow_always' | 'deny';
        }
      : undefined;

    // Build SDK-level AskUserQuestion handler
    const sdkAskQuestionHandler = async (
      questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>,
      signal?: AbortSignal,
    ): Promise<Record<string, string>> => {
      if (!questions.length) return {};
      const q = questions[0];
      const permId = `askq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Build question text
      const header = q.header ? `📋 **${q.header}**\n\n` : '';
      const optionsList = q.options
        .map((opt, i) => `${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`)
        .join('\n');
      const questionText = `${header}${q.question}\n\n${optionsList}`;

      // Build option buttons
      const buttons: Array<{ label: string; callbackData: string; style: 'primary' | 'danger' }> = q.options.map((opt, idx) => ({
        label: `${idx + 1}. ${opt.label}`,
        callbackData: `perm:allow:${permId}:askq:${idx}`,
        style: 'primary' as const,
      }));
      buttons.push({
        label: '❌ Skip',
        callbackData: `perm:allow:${permId}:askq_skip`,
        style: 'danger' as const,
      });

      // Store question data for answer resolution
      this.sdkQuestionData.set(permId, { questions });

      // Send question card via adapter
      const hint = msg.channelType === 'feishu'
        ? '\n\n💬 回复数字选择，或直接输入内容'
        : '\n\n💬 Reply with number to select, or type your answer';

      const outMsg: import('../channels/types.js').OutboundMessage = {
        chatId: msg.chatId,
        text: msg.channelType !== 'telegram' ? questionText + hint : undefined,
        html: msg.channelType === 'telegram' ? questionText.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>') + hint : undefined,
        buttons,
        feishuHeader: msg.channelType === 'feishu' ? { template: 'blue', title: '❓ Question' } : undefined,
      };
      const sendResult = await adapter.send(outMsg);
      this.permissions.trackPermissionMessage(sendResult.messageId, permId, binding.sessionId, msg.channelType);

      // Abort handling
      const abortCleanup = () => {
        this.permissions.getGateway().resolve(permId, 'deny', 'Cancelled');
        this.sdkQuestionData.delete(permId);
      };
      if (signal?.aborted) { abortCleanup(); throw new Error('Cancelled'); }
      signal?.addEventListener('abort', abortCleanup, { once: true });

      // Wait for answer (5 min timeout)
      const result = await this.permissions.getGateway().waitFor(permId, {
        timeoutMs: 5 * 60 * 1000,
        onTimeout: () => { this.sdkQuestionData.delete(permId); },
      });
      signal?.removeEventListener('abort', abortCleanup);

      if (result.behavior === 'deny') {
        this.sdkQuestionData.delete(permId);
        // Return empty answers instead of throwing — Claude handles gracefully
        adapter.editMessage(msg.chatId, sendResult.messageId, {
          chatId: msg.chatId,
          text: '⏭ Skipped',
          buttons: [],
          feishuHeader: msg.channelType === 'feishu' ? { template: 'grey', title: '⏭ Skipped' } : undefined,
        }).catch(() => {});
        return { [q.question]: '' };
      }

      // User answered — auto-allow the next tool permission in this query
      askQuestionApproved = true;

      // Check for free text answer first, then option index
      const textAnswer = this.sdkQuestionTextAnswers.get(permId);
      this.sdkQuestionTextAnswers.delete(permId);
      this.sdkQuestionData.delete(permId);

      if (textAnswer !== undefined) {
        // Free text reply
        adapter.editMessage(msg.chatId, sendResult.messageId, {
          chatId: msg.chatId,
          text: `✅ Answer: ${textAnswer.length > 50 ? textAnswer.slice(0, 47) + '...' : textAnswer}`,
          feishuHeader: msg.channelType === 'feishu' ? { template: 'green', title: '✅ Answered' } : undefined,
        }).catch(() => {});
        return { [q.question]: textAnswer };
      }

      // Option index reply
      const optionIndex = this.sdkQuestionAnswers.get(permId) ?? 0;
      this.sdkQuestionAnswers.delete(permId);
      const selected = q.options[optionIndex];

      adapter.editMessage(msg.chatId, sendResult.messageId, {
        chatId: msg.chatId,
        text: `✅ Selected: ${selected?.label ?? '?'}`,
        feishuHeader: msg.channelType === 'feishu' ? { template: 'green', title: `✅ ${selected?.label ?? '?'}` } : undefined,
      }).catch(() => {});

      return { [q.question]: selected?.label ?? '' };
    };

    try {
      const result = await this.engine.processMessage({
        sessionId: binding.sessionId,
        text: msg.text,
        attachments: msg.attachments,
        llm: this.getProvider(msg.channelType, msg.chatId),
        sdkPermissionHandler,
        sdkAskQuestionHandler,
        effort: this.state.getEffort(msg.channelType, msg.chatId),
        model: this.state.getModel(msg.channelType, msg.chatId),
        onControls: (ctrl) => {
          const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
          this.activeControls.set(chatKey, ctrl);
        },
        onTextDelta: (delta) => renderer.onTextDelta(delta),
        onToolStart: (event) => {
          renderer.onToolStart(event.name);
        },
        onToolResult: (_event) => {
          // No-op — MessageRenderer counts on start, not complete
        },
        onAgentStart: (_data) => {
          renderer.onToolStart('Agent');
        },
        onAgentProgress: (_data) => {
          // No-op — flat display
        },
        onAgentComplete: (_data) => {
          // No-op — flat display
        },
        onToolProgress: (_data) => {
          // No-op — flat display
        },
        onRateLimit: (data) => {
          if (data.status === 'rejected') {
            renderer.onTextDelta('\n⚠️ Rate limited. Retrying...\n');
          } else if (data.status === 'allowed_warning' && data.utilization) {
            renderer.onTextDelta(`\n⚠️ Rate limit: ${Math.round(data.utilization * 100)}% used\n`);
          }
        },
        onQueryResult: (event) => {
          if (event.permissionDenials?.length) {
            console.warn(`[bridge] Permission denials: ${event.permissionDenials.map(d => d.toolName).join(', ')}`);
          }
          const usage = { input_tokens: event.usage.inputTokens, output_tokens: event.usage.outputTokens, cost_usd: event.usage.costUsd };
          completedStats = costTracker.finish(usage);
          renderer.onComplete(completedStats);
        },
        onPromptSuggestion: (suggestion) => {
          // Send as a quick-reply button after the response completes
          const chatId = threadId && adapter.channelType === 'discord' ? threadId : msg.chatId;
          const truncated = suggestion.length > 60 ? suggestion.slice(0, 57) + '...' : suggestion;
          adapter.send({
            chatId,
            text: `💡 ${truncated}`,
            buttons: [{ label: '💡 ' + truncated, callbackData: `suggest:${suggestion.slice(0, 200)}`, style: 'default' as const }],
          }).catch(() => {});
        },
        onError: (err) => renderer.onError(err),
      });

      // Success: change to done reaction
      adapter.addReaction(reactionChatId, msg.messageId, reactions.done).catch(() => {});
    } catch (err) {
      // Error: change to error reaction
      adapter.addReaction(reactionChatId, msg.messageId, reactions.error).catch(() => {});
      throw err;
    } finally {
      clearInterval(typingInterval);
      renderer.dispose();
      this.activeControls.delete(this.state.stateKey(msg.channelType, msg.chatId));
      // Close Feishu streaming card (no-op: streaming disabled)
      // if (feishuSession) { feishuSession.close().catch(() => {}); }
    }

    return true;
  }

}
