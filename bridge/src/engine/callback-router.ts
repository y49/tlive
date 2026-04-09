import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import type { ControlPanel } from './control-panel.js';

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

  constructor(
    private permissions: PermissionCoordinator,
    private sdkState: SdkQuestionState,
    private coreAvailable: () => boolean,
    private handleInboundMessage: (adapter: BaseChannelAdapter, msg: InboundMessage) => Promise<boolean>,
  ) {}

  /** Inject ControlPanel after construction (avoids circular deps) */
  setControlPanel(panel: ControlPanel): void {
    this.controlPanel = panel;
  }

  async handle(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    if (!msg.callbackData) return false;

    // v1.0 terminal question callbacks (askq:<toolUseId>:<option|skip>)
    // Only match the terminal v1.0 format (3 parts) — hook-based askq has 4 parts with sessionId
    if (msg.callbackData.startsWith('askq:') && !msg.callbackData.startsWith('askq_')) {
      const parts = msg.callbackData.split(':');
      if (parts.length === 3 && this.onTerminalQuestionCallback) {
        this.onTerminalQuestionCallback(msg.callbackData);
        const selection = parts[2];
        const label = selection === 'skip' ? '⏭ Skipped' : `✅ Selected option ${parseInt(selection, 10) + 1}`;
        await adapter.editMessage(msg.chatId, msg.messageId, {
          chatId: msg.chatId,
          text: label,
          buttons: [],
        }).catch(() => {});
        return true;
      }
    }

    // v1.0 terminal permission callbacks (perm:allow:<toolUseId>, perm:deny:<id>, perm:takeover:<id>)
    if (msg.callbackData.startsWith('perm:allow:') || msg.callbackData.startsWith('perm:deny:') || msg.callbackData.startsWith('perm:takeover:')) {
      const parts = msg.callbackData.split(':');
      if (parts.length === 3) {
        const [, action, toolUseId] = parts;
        // Forward to tlive claude process via IPC
        if (this.onTerminalPermissionCallback) {
          this.onTerminalPermissionCallback(action, toolUseId, '');
          // Update the message to show the action was taken
          const label = action === 'allow' ? '✅ Allowed' : action === 'deny' ? '❌ Denied' : '🖥 Takeover';
          await adapter.editMessage(msg.chatId, msg.messageId, {
            chatId: msg.chatId,
            text: label,
            buttons: [],
          }).catch(() => {});
          return true;
        }
        // Fall through to existing perm: handling if no IPC callback
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

    // AskUserQuestion answer callbacks (askq:{hookId}:{optionIndex}:{sessionId})
    // NOTE: check toggle/submit/skip BEFORE this — they also start with "askq"
    if (msg.callbackData.startsWith('askq:') && !msg.callbackData.startsWith('askq_')) {
      const parts = msg.callbackData.split(':');
      const hookId = parts[1];
      const optionIndex = parseInt(parts[2], 10);
      const sessionId = parts[3] || '';
      await this.permissions.resolveAskQuestion(
        hookId, optionIndex, sessionId,
        msg.messageId, adapter, msg.chatId, this.coreAvailable(),
      );
      return true;
    }

    // AskUserQuestion multi-select toggle (askq_toggle:{hookId}:{idx}:{sessionId})
    if (msg.callbackData.startsWith('askq_toggle:')) {
      const parts = msg.callbackData.split(':');
      const hookId = parts[1];
      const optionIndex = parseInt(parts[2], 10);
      const selected = this.permissions.toggleMultiSelectOption(hookId, optionIndex);
      if (selected === null) return true;

      const sessionId = parts[3] || '';
      const card = this.permissions.buildMultiSelectCard(hookId, sessionId, selected, adapter.channelType);
      if (card) {
        await adapter.editMessage(msg.chatId, msg.messageId, {
          chatId: msg.chatId,
          text: card.text,
          html: card.html,
          buttons: card.buttons,
          feishuHeader: adapter.channelType === 'feishu' ? { template: 'blue', title: '❓ Terminal' } : undefined,
        });
      }
      return true;
    }

    // AskUserQuestion multi-select submit (askq_submit:{hookId}:{sessionId})
    if (msg.callbackData.startsWith('askq_submit:')) {
      const parts = msg.callbackData.split(':');
      const hookId = parts[1];
      const sessionId = parts[2] || '';
      await this.permissions.resolveMultiSelect(
        hookId, sessionId,
        msg.messageId, adapter, msg.chatId, this.coreAvailable(),
      );
      return true;
    }

    // AskUserQuestion skip callback (askq_skip:{hookId}:{sessionId})
    if (msg.callbackData.startsWith('askq_skip:')) {
      const parts = msg.callbackData.split(':');
      const hookId = parts[1];
      const sessionId = parts[2] || '';
      await this.permissions.resolveAskQuestionSkip(
        hookId, sessionId,
        msg.messageId, adapter, msg.chatId, this.coreAvailable(),
      );
      return true;
    }

    // SDK AskUserQuestion multi-select submit (askq_submit_sdk:{permId})
    if (msg.callbackData.startsWith('askq_submit_sdk:')) {
      const permId = msg.callbackData.split(':')[1];
      const selected = this.permissions.getToggledSelections(permId);
      if (selected.size === 0) {
        await adapter.send({ chatId: msg.chatId, text: '⚠️ No options selected' });
        return true;
      }
      const qData = this.sdkState.sdkQuestionData.get(permId);
      if (qData) {
        const q = qData.questions[0];
        const selectedLabels = [...selected].sort((a, b) => a - b).map(i => q.options[i]?.label).filter(Boolean);
        const answerText = selectedLabels.join(', ');
        this.sdkState.sdkQuestionTextAnswers.set(permId, answerText);
        adapter.editMessage(msg.chatId, msg.messageId, {
          chatId: msg.chatId,
          text: `✅ Selected: ${selectedLabels.join(', ')}`,
          buttons: [],
          feishuHeader: msg.channelType === 'feishu' ? { template: 'green', title: '✅ Answered' } : undefined,
        }).catch(() => {});
      }
      this.permissions.cleanupQuestion(permId);
      this.permissions.getGateway().resolve(permId, 'allow');
      return true;
    }

    // Hook permission callbacks (hook:allow:ID:sessionId, hook:allow_always:ID:sessionId, hook:deny:ID:sessionId)
    if (msg.callbackData.startsWith('hook:')) {
      const parts = msg.callbackData.split(':');
      const decision = parts[1];
      const hookId = parts[2];
      const sessionId = parts[3] || '';
      await this.permissions.resolveHookCallback(hookId, decision, sessionId, msg.messageId, adapter, msg.chatId, this.coreAvailable());
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
        adapter.editMessage(msg.chatId, msg.messageId, {
          chatId: msg.chatId,
          text: `✅ Selected: ${selected.label}`,
          buttons: [],
          feishuHeader: { template: 'green', title: `✅ ${selected.label}` },
        }).catch(() => {});
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
    console.log(`[tlive:engine] Perm callback: ${msg.callbackData}, gateway pending: ${this.permissions.getGateway().pendingCount()}`);
    this.permissions.handleBrokerCallback(msg.callbackData);
    return true;
  }
}
