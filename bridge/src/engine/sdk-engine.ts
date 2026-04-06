import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage, OutboundMessage } from '../channels/types.js';
import type { LLMProvider, QueryControls } from '../providers/base.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import type { SessionStateManager } from './session-state.js';
import type { ChannelRouter } from './router.js';
import type { SdkQuestionState } from './callback-router.js';
import { ConversationEngine } from './conversation.js';
import { MessageRenderer } from './message-renderer.js';
import { CostTracker } from './cost-tracker.js';
import type { UsageStats } from './cost-tracker.js';
import { getToolCommand } from './tool-registry.js';
import { markdownToTelegram } from '../markdown/index.js';
import { downgradeHeadings } from '../markdown/feishu.js';
import { chunkByParagraph } from '../delivery/delivery.js';
import type { FeishuStreamingSession } from '../channels/feishu-streaming.js';

/**
 * Handles the full SDK conversation flow: session management, renderer setup,
 * permission handler construction, AskUserQuestion handling, and processMessage call.
 *
 * Provider-agnostic — works with both Claude SDK and Codex via the LLMProvider interface.
 */
export class SDKEngine {
  private engine = new ConversationEngine();
  private activeControls = new Map<string, QueryControls>();

  // SDK AskUserQuestion state — shared with CallbackRouter via SdkQuestionState interface
  private sdkQuestionData = new Map<string, { questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>; chatId: string }>();
  private sdkQuestionAnswers = new Map<string, number>();
  private sdkQuestionTextAnswers = new Map<string, string>();

  constructor(
    private state: SessionStateManager,
    private router: ChannelRouter,
    private permissions: PermissionCoordinator,
  ) {}

  /** Expose question state for CallbackRouter */
  getQuestionState(): SdkQuestionState {
    return {
      sdkQuestionData: this.sdkQuestionData,
      sdkQuestionAnswers: this.sdkQuestionAnswers,
      sdkQuestionTextAnswers: this.sdkQuestionTextAnswers,
    };
  }

  /** Expose active controls for /stop command */
  getActiveControls(): Map<string, QueryControls> {
    return this.activeControls;
  }

  /** Find pending SDK question for text reply routing */
  findPendingQuestion(_channelType: string, chatId: string): { permId: string } | null {
    for (const [permId, data] of this.sdkQuestionData) {
      if (data.chatId === chatId && this.permissions.getGateway().isPending(permId)) {
        return { permId };
      }
    }
    return null;
  }

  /** Run a full SDK conversation turn */
  async handleMessage(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    provider: LLMProvider,
  ): Promise<boolean> {
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
    let feishuSession: FeishuStreamingSession | null = null;

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

    let completedStats: UsageStats | undefined;

    // When an AskUserQuestion is approved, auto-allow the next permission request
    // to avoid redundant confirmation (e.g. "delete this?" → yes → Bash permission)
    let askQuestionApproved = false;

    // Build SDK-level permission handler based on /perm mode
    const permMode = this.state.getPermMode(msg.channelType, msg.chatId);
    const sdkPermissionHandler = permMode === 'on'
      ? async (toolName: string, toolInput: Record<string, unknown>, promptSentence: string, _signal?: AbortSignal) => {
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

          // NOTE: We intentionally ignore the SDK abort signal for IM permissions.
          // IM users may respond hours later — the abort signal should not auto-deny
          // a permission the user hasn't seen yet. No timeout either.

          // Render permission inline in the terminal card
          const inputStr = getToolCommand(toolName, toolInput)
            || JSON.stringify(toolInput, null, 2);
          const buttons: Array<{ label: string; callbackData: string; style: string }> = [
            { label: '✅ Allow', callbackData: `perm:allow:${permId}`, style: 'primary' },
            { label: '❌ Deny', callbackData: `perm:deny:${permId}`, style: 'danger' },
          ];
          renderer.onPermissionNeeded(toolName, inputStr, permId, buttons);

          // Wait for user response — no timeout, IM users may respond much later
          const result = await this.permissions.getGateway().waitFor(permId);
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
      _signal?: AbortSignal,
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

      // Build option buttons: multiSelect uses toggle+submit, singleSelect uses direct select
      const isMulti = q.multiSelect;
      const buttons: Array<{ label: string; callbackData: string; style: 'primary' | 'danger'; row?: number }> = isMulti
        ? [
            ...q.options.map((opt, idx) => ({
              label: `☐ ${opt.label}`,
              callbackData: `askq_toggle:${permId}:${idx}:sdk`,
              style: 'primary' as const,
              row: idx,
            })),
            { label: '✅ Submit', callbackData: `askq_submit_sdk:${permId}`, style: 'primary' as const, row: q.options.length },
            { label: '❌ Skip', callbackData: `perm:allow:${permId}:askq_skip`, style: 'danger' as const, row: q.options.length },
          ]
        : [
            ...q.options.map((opt, idx) => ({
              label: `${idx + 1}. ${opt.label}`,
              callbackData: `perm:allow:${permId}:askq:${idx}`,
              style: 'primary' as const,
            })),
            { label: '❌ Skip', callbackData: `perm:allow:${permId}:askq_skip`, style: 'danger' as const },
          ];

      // Store question data for answer resolution (also needed for toggle state)
      this.sdkQuestionData.set(permId, { questions, chatId: msg.chatId });
      // Store in permission coordinator for toggle tracking (reuse hookQuestionData)
      if (isMulti) {
        this.permissions.storeQuestionData(permId, questions);
      }

      // Create gateway entry BEFORE sending — prevents race condition where user
      // replies before waitFor is called, causing isPending() to return false
      // NOTE: We intentionally ignore the abort signal for AskUserQuestion.
      // IM users may respond hours later — questions must wait for user response.
      const waitPromise = this.permissions.getGateway().waitFor(permId);

      // Send question card AFTER gateway entry exists — user replies are now safe
      const hint = isMulti
        ? (msg.channelType === 'feishu' ? '\n\n💬 点击选项切换选中，然后按 Submit 确认' : '\n\n💬 Tap options to toggle, then Submit')
        : (msg.channelType === 'feishu' ? '\n\n💬 回复数字选择，或直接输入内容' : '\n\n💬 Reply with number to select, or type your answer');

      const outMsg: OutboundMessage = {
        chatId: msg.chatId,
        text: msg.channelType !== 'telegram' ? questionText + hint : undefined,
        html: msg.channelType === 'telegram' ? questionText.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>') + hint : undefined,
        buttons,
        feishuHeader: msg.channelType === 'feishu' ? { template: 'blue', title: '❓ Question' } : undefined,
      };
      const sendResult = await adapter.send(outMsg);
      this.permissions.trackPermissionMessage(sendResult.messageId, permId, binding.sessionId, msg.channelType);

      // Await user answer — waits indefinitely until user responds via IM
      const result = await waitPromise;

      if (result.behavior === 'deny') {
        this.sdkQuestionData.delete(permId);
        // Throw so provider returns { behavior: 'deny' } — Claude stops asking
        adapter.editMessage(msg.chatId, sendResult.messageId, {
          chatId: msg.chatId,
          text: '⏭ Skipped',
          buttons: [],
          feishuHeader: msg.channelType === 'feishu' ? { template: 'grey', title: '⏭ Skipped' } : undefined,
        }).catch(() => {});
        throw new Error('User skipped question');
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
          buttons: [],
          feishuHeader: msg.channelType === 'feishu' ? { template: 'green', title: '✅ Answered' } : undefined,
        }).catch(() => {});
        return { [q.question]: textAnswer };
      }

      // Option index reply (button callback already edited the message — skip redundant edit)
      const optionIndex = this.sdkQuestionAnswers.get(permId);
      this.sdkQuestionAnswers.delete(permId);
      const selected = optionIndex !== undefined ? q.options[optionIndex] : undefined;
      const answerLabel = selected?.label ?? '';

      if (!selected) {
        // Button callback already edited the card; only update if we somehow have no answer
        adapter.editMessage(msg.chatId, sendResult.messageId, {
          chatId: msg.chatId,
          text: '✅ Answered',
          buttons: [],
          feishuHeader: msg.channelType === 'feishu' ? { template: 'green', title: '✅ Answered' } : undefined,
        }).catch(() => {});
      }

      return { [q.question]: answerLabel };
    };

    try {
      const result = await this.engine.processMessage({
        sessionId: binding.sessionId,
        text: msg.text,
        attachments: msg.attachments,
        llm: provider,
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
    }

    return true;
  }
}
