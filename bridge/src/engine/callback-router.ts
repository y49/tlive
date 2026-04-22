import type { BaseChannelAdapter } from '../channels/base.js';
import type { ChannelType, InboundMessage } from '../channels/types.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import type { ControlPanel } from './control-panel.js';
import type { NotificationRenderer } from '../renderers/types.js';
import type { PermissionBroker as RuntimePermissionBroker } from '../../../src/session/permission-broker.js';
import type { PermissionDecision } from '../../../src/runtime/types.js';

/** Shared SDK question state — owned by SDKEngine, read/written by CallbackRouter */
export interface SdkQuestionState {
  sdkQuestionData: Map<string, { questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string; preview?: string }>; multiSelect: boolean }>; chatId: string }>;
  sdkQuestionAnswers: Map<string, number>;
  sdkQuestionTextAnswers: Map<string, string>;
}

/**
 * Routes all button callback interactions from IM platforms.
 *
 * Handles: prompt suggestions, AskUserQuestion buttons (single/multi-select),
 * hook permission callbacks, SDK permission callbacks, broker callbacks,
 * and control panel interactions.
 */
export class CallbackRouter {
  private controlPanel?: ControlPanel;
  /** Callback for forwarding terminal permission actions via IPC to `tlive claude` */
  onTerminalPermissionCallback?: (action: string, toolUseId: string, sessionId: string) => void;
  /** Callback for forwarding terminal question answers via IPC to `tlive claude` */
  onTerminalQuestionCallback?: (callbackData: string) => void;
  /** Callback for resuming a discovered Claude session from IM */
  onResumeSession?: (adapter: BaseChannelAdapter, chatId: string, sessionId: string, workdir: string) => void;
  /** Callback for stopping the active session from a permission prompt */
  onStopSession?: (adapter: BaseChannelAdapter, chatId: string) => Promise<void> | void;

  constructor(
    private permissions: PermissionCoordinator,
    private sdkState: SdkQuestionState,
    private handleInboundMessage: (adapter: BaseChannelAdapter, msg: InboundMessage) => Promise<boolean>,
    private renderers: Map<ChannelType, NotificationRenderer>,
    /** Session-level broker. When set, permission buttons whose id looks like
     *  `${sessionId}:${toolUseId}` route through here instead of the legacy
     *  scanner gateway. */
    private runtimeBroker?: RuntimePermissionBroker,
  ) {}

  /** Inject ControlPanel after construction (avoids circular deps) */
  setControlPanel(panel: ControlPanel): void {
    this.controlPanel = panel;
  }

  async handle(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    if (!msg.callbackData) return false;

    // Session resume callbacks (resume:ignore:<sessionId> or resume:<sessionId>:<workdir>)
    if (msg.callbackData.startsWith('resume:')) {
      const parts = msg.callbackData.split(':');
      if (parts[1] === 'ignore') {
        const renderer = this.renderers.get(adapter.channelType)!;
        await adapter.editMessage(msg.chatId, msg.messageId, renderer.renderSimpleText('🔕 Ignored')).catch(() => {});
        return true;
      }
      // Resume session: resume:<sessionId>:<workdir> (workdir may contain colons on Windows)
      const sessionId = parts[1];
      const workdir = parts.slice(2).join(':');
      if (this.onResumeSession) {
        this.onResumeSession(adapter, msg.chatId, sessionId, workdir);
        const renderer = this.renderers.get(adapter.channelType)!;
        await adapter.editMessage(msg.chatId, msg.messageId, renderer.renderSimpleText(`💬 Resuming session #${sessionId.slice(0, 6)}...`)).catch(() => {});
      }
      return true;
    }

    // v1.0 terminal question callbacks (askq:<toolUseId>:<option|skip>)
    // Only match the terminal v1.0 format (3 parts) — hook-based askq has 4 parts with sessionId
    if (msg.callbackData.startsWith('askq:') && !msg.callbackData.startsWith('askq_')) {
      const parts = msg.callbackData.split(':');
      if (parts.length === 3 && this.onTerminalQuestionCallback) {
        this.onTerminalQuestionCallback(msg.callbackData);
        const selection = parts[2];
        const label = selection === 'skip' ? '⏭ Skipped' : `✅ Selected option ${parseInt(selection, 10) + 1}`;
        const renderer = this.renderers.get(adapter.channelType)!;
        await adapter.editMessage(msg.chatId, msg.messageId, renderer.renderSimpleText(label)).catch(() => {});
        return true;
      }
    }

    // v1.0 terminal permission callbacks (perm:allow:<toolUseId>, perm:deny:<id>, perm:takeover:<id>)
    // SDK sessions use permId format "sdk-<ts>-<rand>" and resolve via the gateway below.
    // Terminal sessions use tool_use_ids and route via IPC.
    // Session-runtime permissions use "sessionId:toolUseId" format and route through runtimeBroker.
    if (msg.callbackData.startsWith('perm:allow:') || msg.callbackData.startsWith('perm:deny:') || msg.callbackData.startsWith('perm:takeover:')) {
      // Session-runtime ids carry a colon (`${sessionId}:${toolUseId}`) so the full
      // callback has >3 parts. We rejoin parts[2..] to recover the id intact.
      const parts = msg.callbackData.split(':');
      const action = parts[1];
      const permId = parts.slice(2).join(':');

      // Route through session-level broker first when it owns the id
      if (this.runtimeBroker && permId.includes(':')) {
        const decision: PermissionDecision =
          action === 'allow' ? 'allow' :
          action === 'deny' ? 'deny' :
          action === 'takeover' ? 'deny' :  // takeover resolves as deny on this path
          'deny';
        if (this.runtimeBroker.resolve(permId, decision)) {
          const label = action === 'allow' ? '✅ Allowed' : action === 'deny' ? '❌ Denied' : '🖥 Takeover';
          const renderer = this.renderers.get(adapter.channelType)!;
          await adapter.editMessage(msg.chatId, msg.messageId, renderer.renderSimpleText(label)).catch(() => {});
          return true;
        }
        // Not found in broker — fall through to legacy paths below.
      }

      if (parts.length === 3) {
        // If this is an SDK-managed permission, let the broker handle it below
        const isSdkPerm = permId.startsWith('sdk-') || this.permissions.getGateway().isPending(permId);
        if (!isSdkPerm && this.onTerminalPermissionCallback) {
          this.onTerminalPermissionCallback(action, permId, '');
          const label = action === 'allow' ? '✅ Allowed' : action === 'deny' ? '❌ Denied' : '🖥 Takeover';
          const renderer = this.renderers.get(adapter.channelType)!;
          await adapter.editMessage(msg.chatId, msg.messageId, renderer.renderSimpleText(label)).catch(() => {});
          return true;
        }
        // Fall through to broker handling for SDK sessions
      }
    }

    // Control panel callbacks (panel:{action}:{chatKey})
    if (msg.callbackData.startsWith('panel:') && this.controlPanel) {
      const action = msg.callbackData.slice('panel:'.length);
      await this.controlPanel.handleCallback(adapter, msg.chatId, msg.messageId, action);
      return true;
    }

    // Prompt suggestion callback — re-inject as a normal user message
    if (msg.callbackData.startsWith('suggest:')) {
      const suggestion = msg.callbackData.slice('suggest:'.length);
      msg.text = suggestion;
      msg.callbackData = undefined;
      return this.handleInboundMessage(adapter, msg);
    }

    // AskUserQuestion multi-select toggle (askq_toggle:{permId}:{idx}:{sessionId})
    if (msg.callbackData.startsWith('askq_toggle:')) {
      const parts = msg.callbackData.split(':');
      const hookId = parts[1];
      const optionIndex = parseInt(parts[2], 10);
      const selected = this.permissions.toggleMultiSelectOption(hookId, optionIndex);
      if (selected === null) return true;

      const sessionId = parts[3] || '';
      const card = this.permissions.buildMultiSelectCard(hookId, sessionId, selected, adapter.channelType);
      if (card) {
        const renderer = this.renderers.get(adapter.channelType)!;
        await adapter.editMessage(msg.chatId, msg.messageId, renderer.renderCommandResponse({
          title: '📋 Select Options',
          body: card.text,
          buttons: card.buttons,
        }));
      }
      return true;
    }

    // SDK AskUserQuestion multi-select submit (askq_submit_sdk:{permId})
    if (msg.callbackData.startsWith('askq_submit_sdk:')) {
      const permId = msg.callbackData.split(':')[1];
      const selected = this.permissions.getToggledSelections(permId);
      if (selected.size === 0) {
        const renderer = this.renderers.get(adapter.channelType)!;
        await adapter.send(msg.chatId, renderer.renderSimpleText('⚠️ No options selected'));
        return true;
      }
      const qData = this.sdkState.sdkQuestionData.get(permId);
      if (qData) {
        const q = qData.questions[0];
        const selectedLabels = [...selected].sort((a, b) => a - b).map(i => q.options[i]?.label).filter(Boolean);
        const answerText = selectedLabels.join(', ');
        this.sdkState.sdkQuestionTextAnswers.set(permId, answerText);
        const renderer = this.renderers.get(adapter.channelType)!;
        adapter.editMessage(msg.chatId, msg.messageId, renderer.renderSimpleText(`✅ Selected: ${selectedLabels.join(', ')}`)).catch(() => {});
      }
      this.permissions.cleanupQuestion(permId);
      this.permissions.getGateway().resolve(permId, 'allow');
      return true;
    }

    // Graduated permission callbacks — resolve gateway, no message edit
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
      console.log(`[tlive:engine] Added ${toolName} to session whitelist`);
      return true;
    }

    if (msg.callbackData.startsWith('perm:allow_bash:')) {
      const parts = msg.callbackData.split(':');
      const permId = parts[2];
      const prefix = parts.slice(3).join(':');
      this.permissions.getGateway().resolve(permId, 'allow');
      this.permissions.addAllowedBashPrefix(prefix);
      console.log(`[tlive:engine] Added Bash(${prefix} *) to session whitelist`);
      return true;
    }

    // SDK AskUserQuestion answer callbacks (perm:allow:permId:askq:optionIndex)
    if (msg.callbackData.includes(':askq:')) {
      const parts = msg.callbackData.split(':');
      const askqIdx = parts.indexOf('askq');
      if (askqIdx >= 0) {
        const permId = parts.slice(2, askqIdx).join(':');
        const optionIndex = parseInt(parts[askqIdx + 1], 10);
        const qData = this.sdkState.sdkQuestionData.get(permId);
        const selected = qData?.questions?.[0]?.options?.[optionIndex];
        if (!selected) return true;
        this.sdkState.sdkQuestionAnswers.set(permId, optionIndex);
        this.permissions.getGateway().resolve(permId, 'allow');
        const renderer = this.renderers.get(adapter.channelType)!;
        adapter.editMessage(msg.chatId, msg.messageId, renderer.renderSimpleText(`✅ Selected: ${selected.label}`)).catch(() => {});
        return true;
      }
    }

    // SDK AskUserQuestion skip (perm:allow:permId:askq_skip)
    if (msg.callbackData.includes(':askq_skip')) {
      const parts = msg.callbackData.split(':');
      const skipIdx = parts.indexOf('askq_skip');
      if (skipIdx >= 0) {
        const permId = parts.slice(2, skipIdx).join(':');
        this.permissions.getGateway().resolve(permId, 'deny', 'Skipped');
        const renderer = this.renderers.get(adapter.channelType)!;
        adapter.editMessage(msg.chatId, msg.messageId, renderer.renderSimpleText('⏭ Skipped')).catch(() => {});
        return true;
      }
    }

    // Stop session from permission prompt (perm:stop:permId)
    if (msg.callbackData.startsWith('perm:stop:')) {
      const permId = msg.callbackData.slice('perm:stop:'.length);
      // Deny the pending permission so the SDK unblocks
      this.permissions.getGateway().resolve(permId, 'deny');
      this.permissions.handleBrokerCallback(`perm:deny:${permId}`);
      // Fire the stop-session callback (e.g., abort the active SDK session)
      if (this.onStopSession) {
        await this.onStopSession(adapter, msg.chatId);
      }
      const renderer = this.renderers.get(adapter.channelType)!;
      await adapter.editMessage(msg.chatId, msg.messageId, renderer.renderSimpleText('🛑 Session stopped')).catch(() => {});
      return true;
    }

    // Regular permission broker callbacks (perm:allow:ID, perm:deny:ID)
    console.log(`[tlive:engine] Perm callback: ${msg.callbackData}, gateway pending: ${this.permissions.getGateway().pendingCount()}`);
    this.permissions.handleBrokerCallback(msg.callbackData);
    return true;
  }
}
