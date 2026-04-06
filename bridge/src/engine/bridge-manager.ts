import { BaseChannelAdapter, createAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
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
import { HookEngine } from './hook-engine.js';
export type { HookNotificationData } from './hook-engine.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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

export class BridgeManager {
  private adapters = new Map<string, BaseChannelAdapter>();
  private running = false;
  private router = new ChannelRouter();
  private coreUrl: string;
  private token: string;
  private coreAvailable = false;
  private state = new SessionStateManager();
  private permissions: PermissionCoordinator;
  private lastChatId = new Map<string, string>();
  /** Pending image attachments waiting for a text message to merge with (key: channelType:chatId) */
  private pendingAttachments = new Map<string, { attachments: import('../channels/types.js').FileAttachment[]; timestamp: number }>();

  private commands: CommandRouter;
  private callbackRouter: CallbackRouter;
  private sdkEngine: SDKEngine;
  private hookEngine: HookEngine;
  private chatIdFile: string;
  /** Cached LLM providers keyed by runtime name */
  private providerCache = new Map<string, LLMProvider>();

  constructor() {
    const config = loadConfig();
    const effectivePublicUrl = config.publicUrl || `http://${getLocalIP()}:${config.port || 4590}`;
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
    this.sdkEngine = new SDKEngine(this.state, this.router, this.permissions);
    this.hookEngine = new HookEngine(this.permissions, () => this.coreAvailable, this.token, getLocalIP);
    this.commands = new CommandRouter(
      this.state,
      () => this.adapters,
      this.router,
      () => this.coreAvailable,
      this.sdkEngine.getActiveControls(),
      this.permissions,
    );
    this.callbackRouter = new CallbackRouter(
      this.permissions,
      this.sdkEngine.getQuestionState(),
      () => this.coreAvailable,
      (adapter, msg) => this.handleInboundMessage(adapter, msg),
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
  storeQuestionData(hookId: string, questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>, contextSuffix?: string): void {
    this.permissions.storeQuestionData(hookId, questions, contextSuffix);
  }

  /** Find a pending SDK AskUserQuestion for numeric text reply */
  private findPendingSdkQuestion(channelType: string, chatId: string): { permId: string } | null {
    return this.sdkEngine.findPendingQuestion(channelType, chatId);
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

  /** Send a hook notification to IM — delegates to HookEngine */
  async sendHookNotification(adapter: BaseChannelAdapter, chatId: string, hook: import('./hook-engine.js').HookNotificationData, receiveIdType?: string): Promise<void> {
    return this.hookEngine.sendNotification(adapter, chatId, hook, receiveIdType);
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
        // Check if input is a valid in-range numeric option selection
        let validOptionIndex = -1;
        const numMatch = trimmed.match(/^(\d+)$/);
        if (numMatch) {
          const idx = parseInt(numMatch[1], 10) - 1;
          if (idx >= 0) {
            // Validate against actual options count to avoid "Selected: ?" for out-of-range numbers
            const qData = pendingHookQ
              ? this.permissions.getQuestionData(pendingHookQ.hookId)
              : pendingSdkQ ? this.sdkEngine.getQuestionState().sdkQuestionData.get(pendingSdkQ.permId) : null;
            const optionsCount = qData?.questions?.[0]?.options?.length ?? 0;
            if (idx < optionsCount) validOptionIndex = idx;
          }
        }

        if (validOptionIndex >= 0) {
          // Numeric reply — select option by validated index
          if (pendingHookQ) {
            await this.permissions.resolveAskQuestion(
              pendingHookQ.hookId, validOptionIndex, pendingHookQ.sessionId,
              pendingHookQ.messageId, adapter, msg.chatId, this.coreAvailable,
            );
            return true;
          }
          if (pendingSdkQ) {
            this.sdkEngine.getQuestionState().sdkQuestionAnswers.set(pendingSdkQ.permId, validOptionIndex);
            this.permissions.getGateway().resolve(pendingSdkQ.permId, 'allow');
            return true;
          }
        } else {
          // Free text reply (including out-of-range numbers) — use text as direct answer
          if (pendingHookQ) {
            await this.permissions.resolveAskQuestionWithText(
              pendingHookQ.hookId, trimmed, pendingHookQ.sessionId,
              pendingHookQ.messageId, adapter, msg.chatId, this.coreAvailable,
            );
            return true;
          }
          if (pendingSdkQ) {
            this.sdkEngine.getQuestionState().sdkQuestionTextAnswers.set(pendingSdkQ.permId, trimmed);
            this.permissions.getGateway().resolve(pendingSdkQ.permId, 'allow');
            return true;
          }
        }
      }
    }

    // Reply routing: quote-reply to a hook message → send to PTY stdin
    if ((msg.text || msg.attachments?.length) && msg.replyToMessageId && this.permissions.isHookMessage(msg.replyToMessageId)) {
      // Before forwarding to PTY, check Core for a pending AskUserQuestion that
      // the bridge hasn't polled yet (race condition: hook creates perm, bridge
      // polls every 2s, user replies before the next poll cycle).
      if (msg.text && this.coreAvailable) {
        try {
          const pendingResp = await fetch(`${this.coreUrl}/api/hooks/pending`, {
            headers: { Authorization: `Bearer ${this.token}` },
            signal: AbortSignal.timeout(2000),
          });
          if (pendingResp.ok) {
            const pending = await pendingResp.json() as Array<{ id: string; tool_name: string; input: unknown; session_id?: string }>;
            const askq = pending.find((p: { tool_name: string }) => p.tool_name === 'AskUserQuestion');
            if (askq) {
              // There's a pending AskUserQuestion — handle text as question answer
              const inputData = (typeof askq.input === 'string'
                ? (() => { try { return JSON.parse(askq.input as string); } catch { return {}; } })()
                : askq.input) as Record<string, unknown>;
              const questions = (inputData?.questions ?? []) as Array<{
                question: string; header: string;
                options: Array<{ label: string; description?: string }>; multiSelect: boolean;
              }>;
              if (questions.length > 0) {
                const q = questions[0];
                const trimmed = msg.text.trim();
                // Store question data if not already stored
                if (!this.permissions.getQuestionData(askq.id)) {
                  this.permissions.storeQuestionData(askq.id, questions);
                  this.permissions.trackPermissionMessage(msg.replyToMessageId, askq.id, askq.session_id || '', adapter.channelType);
                }
                // Numeric → option selection; else → free text
                const numMatch = trimmed.match(/^(\d+)$/);
                const idx = numMatch ? parseInt(numMatch[1], 10) - 1 : -1;
                if (idx >= 0 && idx < q.options.length) {
                  await this.permissions.resolveAskQuestion(
                    askq.id, idx, askq.session_id || '',
                    msg.replyToMessageId, adapter, msg.chatId, this.coreAvailable,
                  );
                } else {
                  await this.permissions.resolveAskQuestionWithText(
                    askq.id, trimmed, askq.session_id || '',
                    msg.replyToMessageId, adapter, msg.chatId, this.coreAvailable,
                  );
                }
                return true;
              }
            }
          }
        } catch { /* non-fatal: fall through to normal PTY routing */ }
      }

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

    // Callback data — delegate to CallbackRouter
    if (msg.callbackData) {
      return this.callbackRouter.handle(adapter, msg);
    }

    // Bridge commands — only intercept known commands, pass others to Claude Code
    if (msg.text.startsWith('/')) {
      const handled = await this.commands.handle(adapter, msg);
      if (handled) return true;
      // Unrecognized slash command → fall through to Claude Code
    }

    // SDK conversation — delegate to SDKEngine
    return this.sdkEngine.handleMessage(adapter, msg, this.getProvider(msg.channelType, msg.chatId));
  }

}
