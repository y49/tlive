import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage, OutboundMessage } from '../channels/types.js';
import type { LLMProvider, QueryControls, LiveSession } from '../providers/base.js';
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
import { getBridgeContext } from '../context.js';

/** Managed session — wraps a LiveSession with per-chat metadata */
interface ManagedSession {
  session: LiveSession;
  workdir: string;
  costTracker: CostTracker;
  lastActiveAt: number;
}

/**
 * Handles the full SDK conversation flow: session management, renderer setup,
 * permission handler construction, AskUserQuestion handling, and turn processing.
 *
 * Provider-agnostic — works with both Claude SDK (LiveSession) and Codex (streamChat fallback).
 */
export class SDKEngine {
  private engine = new ConversationEngine();
  private activeControls = new Map<string, QueryControls>();

  /** Session registry: sessionKey → ManagedSession */
  private registry = new Map<string, ManagedSession>();
  /** Current working card messageId per chat — for steer matching */
  private activeMessageIds = new Map<string, string>();
  /** Queued messages per chat — processed after current turn completes */
  private messageQueue = new Map<string, Array<InboundMessage>>();

  // SDK AskUserQuestion state — shared with CallbackRouter via SdkQuestionState interface
  private sdkQuestionData = new Map<string, { questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string; preview?: string }>; multiSelect: boolean }>; chatId: string }>();
  private sdkQuestionAnswers = new Map<string, number>();
  private sdkQuestionTextAnswers = new Map<string, string>();

  /** Idle timeout for LiveSessions (30 minutes) */
  private static SESSION_IDLE_MS = 30 * 60 * 1000;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private state: SessionStateManager,
    private router: ChannelRouter,
    private permissions: PermissionCoordinator,
  ) {}

  /** Start periodic cleanup of idle LiveSessions */
  startSessionPruning(): void {
    this.pruneTimer = setInterval(() => this.pruneIdleSessions(), 60_000);
  }

  /** Stop periodic cleanup */
  stopSessionPruning(): void {
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null; }
  }

  /** Close sessions idle longer than SESSION_IDLE_MS */
  private pruneIdleSessions(): void {
    const now = Date.now();
    for (const [key, managed] of this.registry) {
      if (!managed.session.isAlive) {
        this.registry.delete(key);
        continue;
      }
      if (!managed.session.isTurnActive && (now - managed.lastActiveAt) > SDKEngine.SESSION_IDLE_MS) {
        console.log(`[tlive:engine] Pruning idle LiveSession: ${key} (idle ${Math.round((now - managed.lastActiveAt) / 60000)}m)`);
        managed.session.close();
        this.registry.delete(key);
      }
    }
  }

  // ── Session Registry ──

  /** Build session key: channelType:chatId:workdir */
  private sessionKey(channelType: string, chatId: string, workdir: string): string {
    return `${channelType}:${chatId}:${workdir}`;
  }

  /** Get or create a LiveSession for this chat+workdir */
  private getOrCreateSession(
    channelType: string, chatId: string, workdir: string,
    sdkSessionId: string | undefined, provider: LLMProvider,
    opts?: { effort?: 'low' | 'medium' | 'high' | 'max'; model?: string },
  ): ManagedSession | null {
    const key = this.sessionKey(channelType, chatId, workdir);
    const existing = this.registry.get(key);
    if (existing?.session.isAlive) return existing;

    // Clean up dead session
    if (existing) this.registry.delete(key);

    // Only create if provider supports live sessions
    if (!provider.capabilities().liveSession || !provider.createSession) return null;

    try {
      const session = provider.createSession({ workingDirectory: workdir, sessionId: sdkSessionId, effort: opts?.effort, model: opts?.model });
      const managed: ManagedSession = { session, workdir, costTracker: new CostTracker(), lastActiveAt: Date.now() };
      this.registry.set(key, managed);
      console.log(`[tlive:engine] Created LiveSession for ${key}`);
      return managed;
    } catch (err) {
      console.error(`[tlive:engine] Failed to create LiveSession for ${key}:`, err);
      return null; // Fall back to per-message streamChat
    }
  }

  /** Close a session (on /new, session expiry, workdir change) */
  closeSession(channelType: string, chatId: string, workdir?: string): void {
    if (workdir) {
      const key = this.sessionKey(channelType, chatId, workdir);
      const managed = this.registry.get(key);
      if (managed) {
        managed.session.close();
        this.registry.delete(key);
        console.log(`[tlive:engine] Closed LiveSession for ${key}`);
      }
    } else {
      // Close ALL sessions for this chat (e.g. on /new)
      const prefix = `${channelType}:${chatId}:`;
      for (const [key, managed] of this.registry) {
        if (key.startsWith(prefix)) {
          managed.session.close();
          this.registry.delete(key);
          console.log(`[tlive:engine] Closed LiveSession for ${key}`);
        }
      }
    }
  }

  // ── Steer / Queue ──

  /** Check if reply-to matches the current working card (for steer) */
  canSteer(channelType: string, chatId: string, replyToMessageId?: string): boolean {
    const chatKey = this.state.stateKey(channelType, chatId);
    const activeId = this.activeMessageIds.get(chatKey);
    if (!replyToMessageId || !activeId || replyToMessageId !== activeId) return false;
    // Find the active session for this chat and check if turn is active
    for (const [key, managed] of this.registry) {
      if (key.startsWith(`${channelType}:${chatId}:`) && managed.session.isTurnActive) {
        return true;
      }
    }
    return false;
  }

  /** Steer the active turn (inject text into running turn) */
  steer(channelType: string, chatId: string, text: string): void {
    for (const [key, managed] of this.registry) {
      if (key.startsWith(`${channelType}:${chatId}:`) && managed.session.isTurnActive) {
        managed.session.steerTurn(text);
        return;
      }
    }
  }

  private static MAX_QUEUE_SIZE = 10;

  /** Queue a message for processing after the current turn completes. Returns false if queue is full. */
  queueMessage(channelType: string, chatId: string, msg: InboundMessage): boolean {
    const chatKey = this.state.stateKey(channelType, chatId);
    const queue = this.messageQueue.get(chatKey) ?? [];
    if (queue.length >= SDKEngine.MAX_QUEUE_SIZE) return false;
    queue.push(msg);
    this.messageQueue.set(chatKey, queue);
    return true;
  }

  /** Dequeue the next message for a chat */
  dequeueMessage(channelType: string, chatId: string): InboundMessage | undefined {
    const chatKey = this.state.stateKey(channelType, chatId);
    const queue = this.messageQueue.get(chatKey);
    if (!queue?.length) return undefined;
    const msg = queue.shift()!;
    if (queue.length === 0) this.messageQueue.delete(chatKey);
    return msg;
  }

  // ── Shared State (CallbackRouter, /stop) ──

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

  // ── AskUserQuestion ──

  /** Ask a single question from an AskUserQuestion call. Returns the answer string. */
  private async askSingleQuestion(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    sessionId: string,
    q: { question: string; header: string; options: Array<{ label: string; description?: string; preview?: string }>; multiSelect: boolean },
  ): Promise<string> {
    const permId = `askq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const header = q.header ? `📋 **${q.header}**\n\n` : '';
    const optionLines: string[] = [];
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i];
      let line = `${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`;
      if (opt.preview) {
        line += '\n' + opt.preview.split('\n').map(l => `   ${l}`).join('\n');
      }
      optionLines.push(line);
    }
    const questionText = `${header}${q.question}\n\n${optionLines.join('\n')}`;

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

    this.sdkQuestionData.set(permId, { questions: [q], chatId: msg.chatId });
    if (isMulti) {
      this.permissions.storeQuestionData(permId, [q]);
    }

    const waitPromise = this.permissions.getGateway().waitFor(permId);

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
    this.permissions.trackPermissionMessage(sendResult.messageId, permId, sessionId, msg.channelType);

    const result = await waitPromise;

    if (result.behavior === 'deny') {
      this.sdkQuestionData.delete(permId);
      adapter.editMessage(msg.chatId, sendResult.messageId, {
        chatId: msg.chatId, text: '⏭ Skipped', buttons: [],
        feishuHeader: msg.channelType === 'feishu' ? { template: 'grey', title: '⏭ Skipped' } : undefined,
      }).catch(() => {});
      throw new Error('User skipped question');
    }

    const textAnswer = this.sdkQuestionTextAnswers.get(permId);
    this.sdkQuestionTextAnswers.delete(permId);
    this.sdkQuestionData.delete(permId);

    if (textAnswer !== undefined) {
      adapter.editMessage(msg.chatId, sendResult.messageId, {
        chatId: msg.chatId,
        text: `✅ Answer: ${textAnswer.length > 50 ? textAnswer.slice(0, 47) + '...' : textAnswer}`,
        buttons: [],
        feishuHeader: msg.channelType === 'feishu' ? { template: 'green', title: '✅ Answered' } : undefined,
      }).catch(() => {});
      return textAnswer;
    }

    const optionIndex = this.sdkQuestionAnswers.get(permId);
    this.sdkQuestionAnswers.delete(permId);
    const selected = optionIndex !== undefined ? q.options[optionIndex] : undefined;
    const answerLabel = selected?.label ?? '';

    if (!selected) {
      adapter.editMessage(msg.chatId, sendResult.messageId, {
        chatId: msg.chatId, text: '✅ Answered', buttons: [],
        feishuHeader: msg.channelType === 'feishu' ? { template: 'green', title: '✅ Answered' } : undefined,
      }).catch(() => {});
    }

    return answerLabel;
  }

  // ── Main Turn Handler ──

  /** Run a full SDK conversation turn */
  async handleMessage(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    provider: LLMProvider,
  ): Promise<boolean> {
    // Check for session expiry (>30 min inactivity) and auto-create new session
    const expired = this.state.checkAndUpdateLastActive(msg.channelType, msg.chatId);
    if (expired) {
      this.closeSession(msg.channelType, msg.chatId);

      const newSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await this.router.rebind(msg.channelType, msg.chatId, newSessionId);
      this.state.clearThread(msg.channelType, msg.chatId);
      this.permissions.clearSessionWhitelist();
    }

    const binding = await this.router.resolve(msg.channelType, msg.chatId);
    const chatKey = this.state.stateKey(msg.channelType, msg.chatId);

    // Resolve working directory
    const { store, defaultWorkdir } = getBridgeContext();
    const session = await store.getSession(binding.sessionId);
    const workdir = session?.workingDirectory ?? defaultWorkdir;

    // Resolve threadId
    let threadId = msg.threadId;
    if (!threadId && adapter.channelType === 'discord') {
      threadId = this.state.getThread(msg.channelType, msg.chatId);
    }
    if (!threadId && msg.threadId) {
      threadId = msg.threadId;
    }

    const reactionChatId = msg.chatId;

    // Start typing heartbeat
    const typingTarget = threadId && adapter.channelType === 'discord' ? threadId : msg.chatId;
    const typingInterval = setInterval(() => {
      adapter.sendTyping(typingTarget).catch(() => {});
    }, 4000);
    adapter.sendTyping(typingTarget).catch(() => {});

    // Reactions
    const reactionEmojis: Record<string, { processing: string; done: string; error: string }> = {
      telegram: { processing: '\u{1F914}', done: '\u{1F44D}', error: '\u{1F631}' },
      feishu: { processing: 'Typing', done: 'OK', error: 'FACEPALM' },
      discord: { processing: '\u{1F914}', done: '\u{1F44D}', error: '\u{274C}' },
    };
    const reactions = reactionEmojis[adapter.channelType] || reactionEmojis.telegram;
    adapter.addReaction(reactionChatId, msg.messageId, reactions.processing).catch(() => {});

    // Renderer
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
    let askQuestionApproved = false;
    const caps = provider.capabilities();

    // Build SDK-level permission handler
    const permMode = this.state.getPermMode(msg.channelType, msg.chatId);
    const sdkPermissionHandler = permMode === 'on'
      ? async (toolName: string, toolInput: Record<string, unknown>, promptSentence: string, _signal?: AbortSignal) => {
          if (this.permissions.isToolAllowed(toolName, toolInput)) {
            console.log(`[tlive:engine] Auto-allowed ${toolName} via session whitelist`);
            return 'allow' as const;
          }
          if (askQuestionApproved) {
            askQuestionApproved = false;
            console.log(`[tlive:engine] Auto-allowed ${toolName} after AskUserQuestion approval`);
            return 'allow' as const;
          }
          const permId = `sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          this.permissions.setPendingSdkPerm(chatKey, permId);
          console.log(`[tlive:engine] Permission request: ${toolName} (${permId}) for ${chatKey}`);
          const inputStr = getToolCommand(toolName, toolInput) || JSON.stringify(toolInput, null, 2);
          const buttons: Array<{ label: string; callbackData: string; style: string }> = [
            { label: '✅ Allow', callbackData: `perm:allow:${permId}`, style: 'primary' },
            { label: '❌ Deny', callbackData: `perm:deny:${permId}`, style: 'danger' },
          ];
          renderer.onPermissionNeeded(toolName, inputStr, permId, buttons);
          const result = await this.permissions.getGateway().waitFor(permId);
          renderer.onPermissionResolved(permId);
          if (permissionReminderMsgId) {
            const icon = result.behavior === 'deny' ? '❌' : '✅';
            adapter.editMessage(msg.chatId, permissionReminderMsgId, {
              chatId: msg.chatId, text: `${permissionReminderTool}: ${permissionReminderInput} ${icon}`,
            }).catch(() => {});
            permissionReminderMsgId = undefined;
          }
          this.permissions.clearPendingSdkPerm(chatKey);
          console.log(`[tlive:engine] Permission resolved: ${toolName} (${permId}) → ${result.behavior}`);
          return result.behavior as 'allow' | 'allow_always' | 'deny';
        }
      : undefined;

    // Build AskUserQuestion handler
    const sdkAskQuestionHandler = async (
      questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string; preview?: string }>; multiSelect: boolean }>,
      _signal?: AbortSignal,
    ): Promise<Record<string, string>> => {
      if (!questions.length) return {};
      const allAnswers: Record<string, string> = {};
      for (const q of questions) {
        const answer = await this.askSingleQuestion(adapter, msg, binding.sessionId, q);
        allAnswers[q.question] = answer;
      }
      askQuestionApproved = true;
      return allAnswers;
    };

    // ── Get or create LiveSession; build per-turn stream ──
    const managed = this.getOrCreateSession(
      msg.channelType, msg.chatId, workdir,
      session?.sdkSessionId, provider,
      { effort: this.state.getEffort(msg.channelType, msg.chatId), model: this.state.getModel(msg.channelType, msg.chatId) },
    );

    let streamResult;
    if (managed) {
      // LiveSession mode — start a new turn
      managed.lastActiveAt = Date.now();
      managed.costTracker.start();
      streamResult = managed.session.startTurn(msg.text, {
        onPermissionRequest: sdkPermissionHandler,
        onAskUserQuestion: sdkAskQuestionHandler,
        effort: this.state.getEffort(msg.channelType, msg.chatId),
        model: this.state.getModel(msg.channelType, msg.chatId),
        attachments: msg.attachments,
      });
    }
    // else: streamResult is undefined → ConversationEngine falls back to streamChat()

    try {
      const result = await this.engine.processMessage({
        sessionId: binding.sessionId,
        text: msg.text,
        attachments: msg.attachments,
        llm: provider,
        sdkPermissionHandler: managed ? undefined : sdkPermissionHandler,
        sdkAskQuestionHandler: managed ? undefined : sdkAskQuestionHandler,
        effort: this.state.getEffort(msg.channelType, msg.chatId),
        model: this.state.getModel(msg.channelType, msg.chatId),
        streamResult,
        onControls: (ctrl) => {
          this.activeControls.set(chatKey, ctrl);
        },
        onTextDelta: (delta) => {
          renderer.onTextDelta(delta);
          if (renderer.messageId && !this.activeMessageIds.has(chatKey)) {
            this.activeMessageIds.set(chatKey, renderer.messageId);
          }
        },
        onToolStart: (event) => {
          renderer.onToolStart(event.name);
        },
        onToolResult: (_event) => {},
        onAgentStart: (_data) => {
          renderer.onToolStart('Agent');
        },
        onAgentProgress: (_data) => {},
        onAgentComplete: (_data) => {},
        onToolProgress: (_data) => {},
        onTodoUpdate: caps.todoTracking ? (todos) => {
          renderer.onTodoUpdate(todos);
        } : undefined,
        onRateLimit: (data) => {
          if (data.status === 'rejected') {
            renderer.onTextDelta('\n⚠️ Rate limited. Retrying...\n');
          } else if (data.status === 'allowed_warning' && data.utilization) {
            renderer.onTextDelta(`\n⚠️ Rate limit: ${Math.round(data.utilization * 100)}% used\n`);
          }
        },
        onQueryResult: (event) => {
          if (event.permissionDenials?.length) {
            console.warn(`[tlive:engine] Permission denials: ${event.permissionDenials.map(d => d.toolName).join(', ')}`);
          }
          const tracker = managed?.costTracker ?? new CostTracker();
          if (!managed) tracker.start();
          const usage = { input_tokens: event.usage.inputTokens, output_tokens: event.usage.outputTokens, cost_usd: event.usage.costUsd, model_usage: event.usage.modelUsage };
          completedStats = tracker.finish(usage);
          renderer.onComplete(completedStats);
        },
        onPromptSuggestion: (suggestion) => {
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

      adapter.addReaction(reactionChatId, msg.messageId, reactions.done).catch(() => {});
    } catch (err) {
      adapter.addReaction(reactionChatId, msg.messageId, reactions.error).catch(() => {});
      throw err;
    } finally {
      clearInterval(typingInterval);
      renderer.dispose();
      this.activeControls.delete(chatKey);
      this.activeMessageIds.delete(chatKey);
    }

    return true;
  }
}
