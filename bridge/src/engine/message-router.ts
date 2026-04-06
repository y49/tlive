import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage, FileAttachment } from '../channels/types.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import type { SessionStateManager } from './session-state.js';
import type { SDKEngine } from './sdk-engine.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

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
    private coreAvailable: () => boolean,
    private coreUrl: string,
    private token: string,
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

        if (this.permissions.pendingPermissionCount() > 1 && !msg.replyToMessageId) {
          const hint = adapter.channelType === 'feishu'
            ? '⚠️ 多个权限待审批，请引用回复具体的权限消息'
            : '⚠️ Multiple permissions pending — reply to the specific permission message';
          await adapter.send({ chatId: msg.chatId, text: hint });
          return { action: 'handled' };
        }
        const permEntry = this.permissions.findHookPermission(msg.replyToMessageId, adapter.channelType);
        if (permEntry && this.coreAvailable()) {
          try {
            await this.permissions.resolveHookPermission(permEntry.permissionId, decision, adapter.channelType, this.coreAvailable());
            const label = decision === 'deny' ? '❌ Denied' : decision === 'allow_always' ? '📌 Always allowed' : '✅ Allowed';
            await adapter.send({ chatId: msg.chatId, text: label });
          } catch (err) {
            await adapter.send({ chatId: msg.chatId, text: `❌ Failed to resolve: ${err}` });
          }
          return { action: 'handled' };
        }
      }
    }

    // 5. Text reply to pending AskUserQuestion — numeric (select option) or free text
    if (msg.text) {
      const trimmed = msg.text.trim();
      const pendingHookQ = this.permissions.getLatestPendingQuestion(adapter.channelType);
      const pendingSdkQ = this.sdkEngine.findPendingQuestion(adapter.channelType, msg.chatId);

      if (pendingHookQ || pendingSdkQ) {
        let validOptionIndex = -1;
        const numMatch = trimmed.match(/^(\d+)$/);
        if (numMatch) {
          const idx = parseInt(numMatch[1], 10) - 1;
          if (idx >= 0) {
            const qData = pendingHookQ
              ? this.permissions.getQuestionData(pendingHookQ.hookId)
              : pendingSdkQ ? this.sdkEngine.getQuestionState().sdkQuestionData.get(pendingSdkQ.permId) : null;
            const optionsCount = qData?.questions?.[0]?.options?.length ?? 0;
            if (idx < optionsCount) validOptionIndex = idx;
          }
        }

        if (validOptionIndex >= 0) {
          if (pendingHookQ) {
            await this.permissions.resolveAskQuestion(
              pendingHookQ.hookId, validOptionIndex, pendingHookQ.sessionId,
              pendingHookQ.messageId, adapter, msg.chatId, this.coreAvailable(),
            );
            return { action: 'handled' };
          }
          if (pendingSdkQ) {
            this.sdkEngine.getQuestionState().sdkQuestionAnswers.set(pendingSdkQ.permId, validOptionIndex);
            this.permissions.getGateway().resolve(pendingSdkQ.permId, 'allow');
            return { action: 'handled' };
          }
        } else {
          if (pendingHookQ) {
            await this.permissions.resolveAskQuestionWithText(
              pendingHookQ.hookId, trimmed, pendingHookQ.sessionId,
              pendingHookQ.messageId, adapter, msg.chatId, this.coreAvailable(),
            );
            return { action: 'handled' };
          }
          if (pendingSdkQ) {
            this.sdkEngine.getQuestionState().sdkQuestionTextAnswers.set(pendingSdkQ.permId, trimmed);
            this.permissions.getGateway().resolve(pendingSdkQ.permId, 'allow');
            return { action: 'handled' };
          }
        }
      }
    }

    // 6. Reply routing: quote-reply to a hook message → send to PTY stdin
    if ((msg.text || msg.attachments?.length) && msg.replyToMessageId && this.permissions.isHookMessage(msg.replyToMessageId)) {
      await this.routeHookReply(adapter, msg);
      return { action: 'handled' };
    }

    // 7. Not handled — pass through to callbacks, commands, SDK engine
    return { action: 'pass' };
  }

  /** Route a quote-reply to a hook message → PTY stdin or pending AskUserQuestion */
  private async routeHookReply(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<void> {
    // Before forwarding to PTY, check Core for a pending AskUserQuestion that
    // the bridge hasn't polled yet (race condition: hook creates perm, bridge
    // polls every 2s, user replies before the next poll cycle).
    if (msg.text && this.coreAvailable()) {
      try {
        const pendingResp = await fetch(`${this.coreUrl}/api/hooks/pending`, {
          headers: { Authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(2000),
        });
        if (pendingResp.ok) {
          const pending = await pendingResp.json() as Array<{ id: string; tool_name: string; input: unknown; session_id?: string }>;
          const askq = pending.find((p: { tool_name: string }) => p.tool_name === 'AskUserQuestion');
          if (askq) {
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
              if (!this.permissions.getQuestionData(askq.id)) {
                this.permissions.storeQuestionData(askq.id, questions);
                this.permissions.trackPermissionMessage(msg.replyToMessageId!, askq.id, askq.session_id || '', adapter.channelType);
              }
              const numMatch = trimmed.match(/^(\d+)$/);
              const idx = numMatch ? parseInt(numMatch[1], 10) - 1 : -1;
              if (idx >= 0 && idx < q.options.length) {
                await this.permissions.resolveAskQuestion(
                  askq.id, idx, askq.session_id || '',
                  msg.replyToMessageId!, adapter, msg.chatId, this.coreAvailable(),
                );
              } else {
                await this.permissions.resolveAskQuestionWithText(
                  askq.id, trimmed, askq.session_id || '',
                  msg.replyToMessageId!, adapter, msg.chatId, this.coreAvailable(),
                );
              }
              return;
            }
          }
        }
      } catch { /* non-fatal: fall through to normal PTY routing */ }
    }

    const entry = this.permissions.getHookMessage(msg.replyToMessageId!)!;
    if (entry.sessionId && this.coreAvailable()) {
      try {
        // If images attached, save as temp files and include paths in the text
        let inputText = msg.text || '';
        if (msg.attachments?.length) {
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
  }
}
