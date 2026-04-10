import { PendingPermissions } from '../permissions/gateway.js';
import { PermissionBroker } from '../permissions/broker.js';

/**
 * Coordinates all permission-related state and resolution logic.
 *
 * Owns SDK permission tracking, AskUserQuestion multi-select state,
 * and dynamic session whitelisting.
 *
 * Extracted from BridgeManager to isolate permission bookkeeping.
 */
export class PermissionCoordinator {
  private gateway: PendingPermissions;
  private broker: PermissionBroker;

  /** Track pending SDK permission IDs per chat for text-based resolution (key: stateKey, value: permId) */
  private pendingSdkPerms = new Map<string, string>();
  /** Store AskUserQuestion data for answer resolution */
  private questionData = new Map<string, { questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>; ts: number; contextSuffix?: string }>();

  /** Track multi-select toggled options per permId (key: permId, value: Set of selected indices) */
  private toggledSelections = new Map<string, Set<number>>();

  /** Dynamic session whitelist — tools approved via "Allow {tool}" button */
  private allowedTools = new Set<string>();
  /** Dynamic Bash prefix whitelist — commands approved via "Allow Bash(prefix *)" */
  private allowedBashPrefixes = new Set<string>();

  constructor(gateway: PendingPermissions, broker: PermissionBroker) {
    this.gateway = gateway;
    this.broker = broker;
  }

  /** Expose the PendingPermissions gateway instance */
  getGateway(): PendingPermissions {
    return this.gateway;
  }

  /** Expose the PermissionBroker instance */
  getBroker(): PermissionBroker {
    return this.broker;
  }

  // --- SDK permission tracking ---

  getPendingSdkPerm(chatKey: string): string | undefined {
    return this.pendingSdkPerms.get(chatKey);
  }

  setPendingSdkPerm(chatKey: string, permId: string): void {
    this.pendingSdkPerms.set(chatKey, permId);
  }

  clearPendingSdkPerm(chatKey: string): void {
    this.pendingSdkPerms.delete(chatKey);
  }

  // --- Parse permission text ---

  /** Parse text as a permission decision */
  parsePermissionText(text: string): string | null {
    const t = text.trim().toLowerCase();
    if (['allow', 'a', 'yes', 'y', '允许', '通过'].includes(t)) return 'allow';
    if (['deny', 'd', 'no', 'n', '拒绝', '否'].includes(t)) return 'deny';
    if (['always', '始终允许'].includes(t)) return 'allow_always';
    return null;
  }

  // --- SDK permission resolution ---

  /** Try to resolve an SDK permission via gateway for a given chat. Returns true if resolved. */
  tryResolveByText(chatKey: string, decision: string): boolean {
    const pendingPermId = this.pendingSdkPerms.get(chatKey);
    if (!pendingPermId) return false;
    const gwDecision = decision === 'deny' ? 'deny' as const
      : decision === 'allow_always' ? 'allow_always' as const
      : 'allow' as const;
    if (this.gateway.resolve(pendingPermId, gwDecision)) {
      this.pendingSdkPerms.delete(chatKey);
      return true;
    }
    return false;
  }

  // --- AskUserQuestion data ---

  /** Store AskUserQuestion data for later answer resolution */
  storeQuestionData(permId: string, questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>, contextSuffix?: string): void {
    this.questionData.set(permId, { questions, ts: Date.now(), contextSuffix });
  }

  /** Get stored AskUserQuestion data (for option count validation) */
  getQuestionData(permId: string): { questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }> } | undefined {
    return this.questionData.get(permId);
  }

  /** Build multi-select toggle card content for AskUserQuestion.
   *  Used both for initial render and toggle re-renders. */
  buildMultiSelectCard(
    permId: string,
    sessionId: string,
    selected: Set<number>,
    channelType: string,
  ): { text: string; html?: string; buttons: Array<{ label: string; callbackData: string; style: 'primary' | 'danger'; row?: number }>; hint: string } | null {
    const qData = this.questionData.get(permId);
    if (!qData) return null;
    const q = qData.questions[0];
    const header = q.header ? `📋 **${q.header}**\n\n` : '';
    const optionsList = q.options
      .map((opt, i) => `${selected.has(i) ? '☑' : '☐'} ${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`)
      .join('\n');
    const text = `${header}${q.question}\n\n${optionsList}`;
    const buttons: Array<{ label: string; callbackData: string; style: 'primary' | 'danger'; row?: number }> = q.options.map((opt, idx) => ({
      label: `${selected.has(idx) ? '☑' : '☐'} ${opt.label}`,
      callbackData: `askq_toggle:${permId}:${idx}:${sessionId}`,
      style: 'primary' as const,
      row: idx,
    }));
    buttons.push(
      { label: '✅ Submit', callbackData: `askq_submit_sdk:${permId}`, style: 'primary', row: q.options.length },
      { label: '❌ Skip', callbackData: `perm:allow:${permId}:askq_skip`, style: 'danger', row: q.options.length },
    );
    const hint = channelType === 'feishu'
      ? '\n\n💬 点击选项切换，然后按 Submit 确认'
      : '\n\n💬 Tap options to toggle, then Submit';
    const html = channelType === 'telegram'
      ? text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>') + hint
      : undefined;
    return { text: text + hint, html, buttons, hint };
  }

  /** Toggle a multi-select option. Returns the current selection set for re-rendering. */
  toggleMultiSelectOption(permId: string, optionIndex: number): Set<number> | null {
    const qData = this.questionData.get(permId);
    if (!qData) return null;
    const q = qData.questions[0];
    if (!q || optionIndex < 0 || optionIndex >= q.options.length) return null;

    let selected = this.toggledSelections.get(permId);
    if (!selected) {
      selected = new Set();
      this.toggledSelections.set(permId, selected);
    }
    if (selected.has(optionIndex)) selected.delete(optionIndex);
    else selected.add(optionIndex);
    return selected;
  }

  /** Get current toggled selections for a permId */
  getToggledSelections(permId: string): Set<number> {
    return this.toggledSelections.get(permId) ?? new Set();
  }

  /** Clean up toggle state and question data for a permId */
  cleanupQuestion(permId: string): void {
    this.questionData.delete(permId);
    this.toggledSelections.delete(permId);
  }

  // --- Dynamic session whitelist ---

  /** Check if a tool is allowed by the dynamic session whitelist */
  isToolAllowed(toolName: string, toolInput: Record<string, unknown>): boolean {
    if (this.allowedTools.has(toolName)) return true;
    if (toolName === 'Bash') {
      const cmd = typeof toolInput.command === 'string' ? toolInput.command : '';
      const prefix = this.extractBashPrefix(cmd);
      if (prefix && this.allowedBashPrefixes.has(prefix)) return true;
    }
    return false;
  }

  /** Add a tool to the session whitelist */
  addAllowedTool(toolName: string): void {
    this.allowedTools.add(toolName);
  }

  /** Add a Bash command prefix to the session whitelist */
  addAllowedBashPrefix(prefix: string): void {
    this.allowedBashPrefixes.add(prefix);
  }

  /** Extract the first word of a Bash command as a prefix */
  extractBashPrefix(command: string): string {
    return command.trim().split(/\s+/)[0] || '';
  }

  /** Clear the dynamic session whitelist (called on /new or session expiry) */
  clearSessionWhitelist(): void {
    this.allowedTools.clear();
    this.allowedBashPrefixes.clear();
  }

  // --- Broker callback delegation ---

  /** Delegate to broker for perm:allow/deny/allow_session callbacks */
  handleBrokerCallback(callbackData: string): boolean {
    return this.broker.handlePermissionCallback(callbackData);
  }
}
