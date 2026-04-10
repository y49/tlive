import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage, ChannelType, FileAttachment } from '../channels/types.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import type { SessionStateManager } from './session-state.js';
import type { SDKEngine } from './sdk-engine.js';
import type { NotificationRenderer } from '../renderers/types.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type RouteResult =
  | { action: 'handled' }
  | { action: 'pass' }       // pass to commands + SDK engine
  | { action: 'unauthorized' };

/**
 * Routes inbound text messages through auth, attachment buffering,
 * permission resolution, AskQuestion text replies, and hook reply routing.
 *
 * Returns a RouteResult indicating whether the message was fully handled
 * or should be passed through to commands and the SDK engine.
 */
export class MessageRouter {
  /** Pending image attachments waiting for a text message to merge with (key: channelType:chatId) */
  private pendingAttachments = new Map<string, { attachments: FileAttachment[]; timestamp: number }>();
  private lastChatId = new Map<string, string>();
  private chatIdFile: string;

  constructor(
    private permissions: PermissionCoordinator,
    private state: SessionStateManager,
    private sdkEngine: SDKEngine,
    private renderers: Map<ChannelType, NotificationRenderer>,
  ) {
    this.chatIdFile = join(homedir(), '.tlive', 'runtime', 'chat-ids.json');
  }

  /** Load persisted chatIds from disk (called once at startup) */
  loadChatIds(): void {
    try {
      const { readFileSync } = require('node:fs');
      const data = JSON.parse(readFileSync(this.chatIdFile, 'utf-8'));
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string') this.lastChatId.set(k, v);
      }
    } catch { /* no saved chat IDs yet */ }
  }

  /** Get the last active chatId for a given channel type (for hook routing) */
  getLastChatId(channelType: string): string {
    return this.lastChatId.get(channelType) ?? '';
  }

  /** Route an inbound message. Returns what happened. */
  async route(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<RouteResult> {
    // 1. Auth check — with pairing mode for Telegram
    if (!adapter.isAuthorized(msg.userId, msg.chatId)) {
      if (adapter.channelType === 'telegram' && 'requestPairing' in adapter && msg.text) {
        const tgAdapter = adapter as any;
        const username = msg.userId;
        const code = tgAdapter.requestPairing(msg.userId, msg.chatId, username);
        if (code) {
          const r = this.renderers.get(adapter.channelType)!;
          await adapter.send(msg.chatId, r.renderSimpleText(
            `🔐 Pairing Required\n\nYour pairing code: ${code}\n\nAsk an admin to run /approve ${code} in an authorized channel.\nCode expires in 1 hour.`
          ));
        }
      }
      return { action: 'unauthorized' };
    }

    // 2. Track last active chatId per channel type (used for hook notification routing)
    if (msg.chatId) {
      this.lastChatId.set(adapter.channelType, msg.chatId);
      try {
        mkdirSync(join(homedir(), '.tlive', 'runtime'), { recursive: true });
        writeFileSync(this.chatIdFile, JSON.stringify(Object.fromEntries(this.lastChatId)));
      } catch { /* non-fatal */ }
    }

    // 3. Image buffering: cache image-only messages, merge into next text message
    const attachKey = `${msg.channelType}:${msg.chatId}`;
    if (msg.attachments?.length && !msg.text && !msg.callbackData) {
      const MAX_ATTACHMENTS = 5;
      const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
      let attachments = msg.attachments.slice(0, MAX_ATTACHMENTS);
      const totalBytes = attachments.reduce((sum, a) => sum + a.base64Data.length, 0);
      if (totalBytes > MAX_TOTAL_BYTES) {
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
      return { action: 'handled' };
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

    // 4. Text-based permission resolution (all platforms — fallback when buttons expire)
    if (msg.text) {
      const decision = this.permissions.parsePermissionText(msg.text);
      if (decision) {
        const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
        if (this.permissions.tryResolveByText(chatKey, decision)) {
          const emoji = decision === 'deny' ? 'NO' : decision === 'allow_always' ? 'DONE' : 'OK';
          adapter.addReaction(msg.chatId, msg.messageId, emoji).catch(() => {});
          return { action: 'handled' };
        }
      }
    }

    // 5. Text reply to pending SDK AskUserQuestion — numeric (select option) or free text
    if (msg.text) {
      const trimmed = msg.text.trim();
      const pendingSdkQ = this.sdkEngine.findPendingQuestion(adapter.channelType, msg.chatId);

      if (pendingSdkQ) {
        let validOptionIndex = -1;
        const numMatch = trimmed.match(/^(\d+)$/);
        if (numMatch) {
          const idx = parseInt(numMatch[1], 10) - 1;
          if (idx >= 0) {
            const qData = this.sdkEngine.getQuestionState().sdkQuestionData.get(pendingSdkQ.permId);
            const optionsCount = qData?.questions?.[0]?.options?.length ?? 0;
            if (idx < optionsCount) validOptionIndex = idx;
          }
        }

        if (validOptionIndex >= 0) {
          this.sdkEngine.getQuestionState().sdkQuestionAnswers.set(pendingSdkQ.permId, validOptionIndex);
          this.permissions.getGateway().resolve(pendingSdkQ.permId, 'allow');
          return { action: 'handled' };
        } else {
          this.sdkEngine.getQuestionState().sdkQuestionTextAnswers.set(pendingSdkQ.permId, trimmed);
          this.permissions.getGateway().resolve(pendingSdkQ.permId, 'allow');
          return { action: 'handled' };
        }
      }
    }

    // 6. Not handled — pass through to callbacks, commands, SDK engine
    return { action: 'pass' };
  }
}
