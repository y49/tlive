import { PendingPermissions } from '../permissions/gateway.js';
import { PermissionBroker } from '../permissions/broker.js';

/**
 * Coordinates all permission-related state and resolution logic.
 *
 * Owns the 6 Maps that track pending permissions, hook deduplication,
 * and message routing for permission flows.
 *
 * Extracted from BridgeManager to isolate permission bookkeeping.
 */
export class PermissionCoordinator {
  private gateway: PendingPermissions;
  private broker: PermissionBroker;
  private coreUrl: string;
  private token: string;

  /** Track pending SDK permission IDs per chat for text-based resolution (key: stateKey, value: permId) */
  private pendingSdkPerms = new Map<string, string>();
  /** Deduplicate hook permission resolutions (with timestamp for TTL cleanup) */
  private resolvedHookIds = new Map<string, number>();
  /** Store original permission card text for card updates after approval (with timestamp) */
  private hookPermissionTexts = new Map<string, { text: string; ts: number }>();
  /** Track permission messages for text-based approval */
  private permissionMessages = new Map<string, { permissionId: string; sessionId: string; timestamp: number }>();
  /** Latest permission per channel type for single-pending shortcut */
  private latestPermission = new Map<string, { permissionId: string; sessionId: string; messageId: string }>();
  /** Track hook messages for reply routing (permission-adjacent) */
  private hookMessages = new Map<string, { sessionId: string; timestamp: number }>();
  /** Store AskUserQuestion data for answer resolution */
  private hookQuestionData = new Map<string, { questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>; ts: number; contextSuffix?: string }>();

  /** Track multi-select toggled options per hookId (key: hookId, value: Set of selected indices) */
  private toggledSelections = new Map<string, Set<number>>();

  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  /** Dynamic session whitelist — tools approved via "Allow {tool}" button */
  private allowedTools = new Set<string>();
  /** Dynamic Bash prefix whitelist — commands approved via "Allow Bash(prefix *)" */
  private allowedBashPrefixes = new Set<string>();

  constructor(gateway: PendingPermissions, broker: PermissionBroker, coreUrl: string, token: string) {
    this.gateway = gateway;
    this.broker = broker;
    this.coreUrl = coreUrl;
    this.token = token;
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

  // --- Hook message tracking ---

  /** Track a hook message for reply routing */
  trackHookMessage(messageId: string, sessionId: string): void {
    this.hookMessages.set(messageId, { sessionId: sessionId || '', timestamp: Date.now() });
    // Prune entries older than 24h
    for (const [id, entry] of this.hookMessages) {
      if (Date.now() - entry.timestamp > 24 * 60 * 60 * 1000) this.hookMessages.delete(id);
    }
  }

  /** Check if a message is a tracked hook message */
  isHookMessage(messageId: string): boolean {
    return this.hookMessages.has(messageId);
  }

  /** Get a hook message entry */
  getHookMessage(messageId: string): { sessionId: string; timestamp: number } | undefined {
    return this.hookMessages.get(messageId);
  }

  // --- Permission message tracking ---

  /** Track a permission message for text-based approval (Feishu) */
  trackPermissionMessage(messageId: string, permissionId: string, sessionId: string, channelType: string): void {
    this.permissionMessages.set(messageId, { permissionId, sessionId, timestamp: Date.now() });
    this.latestPermission.set(channelType, { permissionId, sessionId, messageId });
    for (const [id, entry] of this.permissionMessages) {
      if (Date.now() - entry.timestamp > 24 * 60 * 60 * 1000) this.permissionMessages.delete(id);
    }
  }

  /** Get the latest pending AskUserQuestion for a channel type */
  getLatestPendingQuestion(channelType: string): { hookId: string; sessionId: string; messageId: string } | null {
    const latest = this.latestPermission.get(channelType);
    if (!latest) return null;
    // Check if this permission has question data (i.e., it's an AskUserQuestion)
    if (!this.hookQuestionData.has(latest.permissionId)) return null;
    // Check not already resolved
    if (this.resolvedHookIds.has(latest.permissionId)) return null;
    return {
      hookId: latest.permissionId,
      sessionId: latest.sessionId,
      messageId: latest.messageId,
    };
  }

  /** Store AskUserQuestion data for later answer resolution */
  storeQuestionData(hookId: string, questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>, contextSuffix?: string): void {
    this.hookQuestionData.set(hookId, { questions, ts: Date.now(), contextSuffix });
  }

  /** Get stored AskUserQuestion data (for option count validation) */
  getQuestionData(hookId: string): { questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }> } | undefined {
    return this.hookQuestionData.get(hookId);
  }

  /** Store original permission card text for later card update */
  storeHookPermissionText(hookId: string, text: string): void {
    this.hookPermissionTexts.set(hookId, { text, ts: Date.now() });
    this.pruneStaleEntries();
  }

  /** Start periodic cleanup of stale entries (call from BridgeManager.start) */
  startPruning(intervalMs = 30 * 60 * 1000): void {
    this.stopPruning();
    this.pruneTimer = setInterval(() => this.pruneStaleEntries(), intervalMs);
  }

  /** Stop periodic cleanup (call from BridgeManager.stop) */
  stopPruning(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  /** Clean up stale entries older than 1 hour */
  pruneStaleEntries(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, ts] of this.resolvedHookIds) {
      if (ts < cutoff) this.resolvedHookIds.delete(id);
    }
    for (const [id, entry] of this.hookPermissionTexts) {
      if (entry.ts < cutoff) this.hookPermissionTexts.delete(id);
    }
    for (const [id, entry] of this.hookQuestionData) {
      if (entry.ts < cutoff) {
        this.hookQuestionData.delete(id);
        this.toggledSelections.delete(id);
      }
    }
  }

  // --- Hook permission resolution (text-based) ---

  /** Find a hook permission entry for text-based resolution. Returns the entry or undefined. */
  findHookPermission(replyToMessageId: string | undefined, channelType: string): { permissionId: string; sessionId: string; timestamp: number } | undefined {
    let permEntry = replyToMessageId ? this.permissionMessages.get(replyToMessageId) : undefined;
    if (!permEntry) {
      if (this.permissionMessages.size === 1) {
        const latest = this.latestPermission.get(channelType);
        if (latest) permEntry = this.permissionMessages.get(latest.messageId);
      }
    }
    return permEntry;
  }

  /** Count of pending permission messages (used for "multiple pending" check) */
  pendingPermissionCount(): number {
    return this.permissionMessages.size;
  }

  /** Resolve a hook permission via Core API */
  async resolveHookPermission(permissionId: string, decision: string, channelType: string, coreAvailable: boolean): Promise<void> {
    if (!coreAvailable) throw new Error('Go Core not available');
    try {
      await fetch(`${this.coreUrl}/api/hooks/permission/${permissionId}/resolve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
        signal: AbortSignal.timeout(5000),
      });
    } finally {
      // Always clean up tracking maps, even if fetch failed —
      // stale entries cause worse problems than a missed resolution
      for (const [id, e] of this.permissionMessages) {
        if (e.permissionId === permissionId) this.permissionMessages.delete(id);
      }
      const latest = this.latestPermission.get(channelType);
      if (latest?.permissionId === permissionId) this.latestPermission.delete(channelType);
    }
  }

  // --- PTY input injection for AskUserQuestion in interactive mode ---

  /**
   * In interactive (non-headless) mode, Claude Code ignores PermissionRequest
   * updatedInput for AskUserQuestion — it renders the interactive picker in the
   * terminal after the hook allows the permission. Inject keystrokes into the
   * PTY to select the option in the picker.
   *
   * Single-select: ↓ × optionIndex + Enter
   * Multi-select:  ↓ × optionIndex + Space (toggle) + Enter (confirm)
   * Free text:     type text + Enter
   */
  /**
   * Send a single keystroke to PTY and wait for it to be processed.
   */
  private async sendKey(sessionId: string, key: string): Promise<boolean> {
    try {
      const resp = await fetch(`${this.coreUrl}/api/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: key }),
        signal: AbortSignal.timeout(3000),
      });
      return resp.ok;
    } catch { return false; }
  }

  injectPtyAnswer(sessionId: string, optionIndex: number, multiSelect?: boolean, freeText?: string, totalOptions?: number): void {
    if (!sessionId) {
      console.log('[PTY-inject] Skipped: no sessionId');
      return;
    }
    console.log(`[PTY-inject] Scheduled: session=${sessionId} idx=${optionIndex} multi=${!!multiSelect} total=${totalOptions ?? '?'} freeText=${freeText ?? 'null'}`);
    // Wait for Claude Code to render the picker after hook returns
    setTimeout(async () => {
      const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
      try {
        if (freeText != null) {
          console.log(`[PTY-inject] Sending free text: "${freeText}"`);
          await this.sendKey(sessionId, freeText + '\r');
        } else if (multiSelect && totalOptions != null) {
          // Multi-select has a two-step confirmation:
          // 1. Navigate to option → Space (toggle) → navigate to Submit → Enter
          // 2. Review screen → Enter (confirm "Submit answers")
          //
          // Picker items: [option0..optionN-1, "Type something", Submit]
          // Submit is at position: totalOptions + 1

          // Step 1: navigate to target option
          for (let i = 0; i < optionIndex; i++) {
            await this.sendKey(sessionId, '\x1b[B');
            await delay(80);
          }
          console.log(`[PTY-inject] Navigated to option ${optionIndex}`);

          // Step 2: toggle checkbox
          await delay(80);
          await this.sendKey(sessionId, ' ');
          console.log('[PTY-inject] Toggled with Space');

          // Step 3: navigate from current option to Submit
          // From optionIndex, Submit is (totalOptions + 1 - optionIndex) downs away
          const downsToSubmit = totalOptions + 1 - optionIndex;
          for (let i = 0; i < downsToSubmit; i++) {
            await delay(80);
            await this.sendKey(sessionId, '\x1b[B');
          }
          console.log(`[PTY-inject] Navigated to Submit (${downsToSubmit} downs)`);

          // Step 4: Enter to go to review screen
          await delay(80);
          await this.sendKey(sessionId, '\r');
          console.log('[PTY-inject] Pressed Enter (review screen)');

          // Step 5: Wait for review screen to render, then Enter to confirm
          await delay(500);
          await this.sendKey(sessionId, '\r');
          console.log('[PTY-inject] Pressed Enter (confirm submit)');
        } else {
          // Single-select: navigate → Enter
          for (let i = 0; i < optionIndex; i++) {
            await this.sendKey(sessionId, '\x1b[B');
            await delay(80);
          }
          console.log(`[PTY-inject] Navigated to option ${optionIndex}`);
          await delay(80);
          await this.sendKey(sessionId, '\r');
          console.log('[PTY-inject] Pressed Enter (select)');
        }
        console.log('[PTY-inject] Done');
      } catch (err) {
        console.log(`[PTY-inject] Error: ${err}`);
      }
    }, 2000);
  }

  // --- Hook callback resolution (button-based) ---

  /** Handle hook button callback. Returns result for adapter to edit the card. */
  async resolveHookCallback(
    hookId: string,
    decision: string,
    sessionId: string,
    messageId: string,
    adapter: { editMessage: (chatId: string, messageId: string, msg: any) => Promise<any>; send: (msg: any) => Promise<any> },
    chatId: string,
    coreAvailable: boolean,
  ): Promise<boolean> {
    // Deduplicate: skip if already resolved
    if (this.resolvedHookIds.has(hookId)) return true;
    this.resolvedHookIds.set(hookId, Date.now());

    if (!coreAvailable) {
      await adapter.send({ chatId, text: '❌ Go Core not available' });
      return true;
    }

    try {
      await fetch(`${this.coreUrl}/api/hooks/permission/${hookId}/resolve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ decision }),
        signal: AbortSignal.timeout(5000),
      });
      const labels: Record<string, string> = {
        allow: '✅ Allowed',
        allow_always: '📌 Always Allowed',
        deny: '❌ Denied',
      };
      const label = labels[decision] || '✅ Allowed';

      // AskUserQuestion cards use hookQuestionData, not hookPermissionTexts
      if (this.hookQuestionData.has(hookId)) {
        this.hookQuestionData.delete(hookId);
        await adapter.editMessage(chatId, messageId, {
          chatId,
          text: decision === 'deny' ? '❌ Skipped' : label,
          buttons: [], // clear buttons
          feishuHeader: {
            template: decision === 'deny' ? 'red' : 'green',
            title: decision === 'deny' ? '❌ Skipped' : label,
          },
        });
      } else {
        const originalText = this.hookPermissionTexts.get(hookId)?.text || '';
        this.hookPermissionTexts.delete(hookId);
        await adapter.editMessage(chatId, messageId, {
          chatId,
          text: originalText + `\n\n${label}`,
          buttons: [], // clear buttons
          feishuHeader: {
            template: decision === 'deny' ? 'red' : 'green',
            title: label,
          },
        });
      }
      // Track confirmation message for reply routing
      if (sessionId) {
        this.trackHookMessage(messageId, sessionId);
      }
    } catch (err) {
      await adapter.send({ chatId, text: `❌ Failed to resolve: ${err}` });
    }
    return true;
  }

  /** Handle AskUserQuestion answer callback — resolve hook with selected answer */
  async resolveAskQuestion(
    hookId: string,
    optionIndex: number,
    sessionId: string,
    messageId: string,
    adapter: { editMessage: (chatId: string, messageId: string, msg: any) => Promise<any>; send: (msg: any) => Promise<any> },
    chatId: string,
    coreAvailable: boolean,
  ): Promise<boolean> {
    if (this.resolvedHookIds.has(hookId)) return true;

    if (!coreAvailable) {
      await adapter.send({ chatId, text: '❌ Go Core not available' });
      return true;
    }
    const questionData = this.hookQuestionData.get(hookId);
    if (!questionData) {
      await adapter.send({ chatId, text: '❌ Question data not found' });
      return true;
    }

    const q = questionData.questions[0];
    const selected = q.options[optionIndex];
    if (!selected) {
      await adapter.send({ chatId, text: `❌ Invalid option (1-${q.options.length})` });
      return true;
    }

    // Mark resolved only after validation passes
    this.resolvedHookIds.set(hookId, Date.now());
    const answers: Record<string, string> = { [q.question]: selected.label };
    const updatedInput = { questions: questionData.questions, answers };

    const resolveBody = JSON.stringify({ decision: 'allow', updated_input: updatedInput });
    console.log(`[AskQ-resolve] Sending to Core: ${resolveBody.slice(0, 300)}`);

    try {
      const resolveResp = await fetch(`${this.coreUrl}/api/hooks/permission/${hookId}/resolve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: resolveBody,
        signal: AbortSignal.timeout(5000),
      });
      console.log(`[AskQ-resolve] Core response: ${resolveResp.status} ${await resolveResp.text()}`);
      const ctx = questionData.contextSuffix || '';
      this.hookQuestionData.delete(hookId);
      await adapter.editMessage(chatId, messageId, {
        chatId,
        text: `✅ Selected: ${selected.label}`,
        buttons: [],
        feishuHeader: {
          template: 'green',
          title: `✅ Terminal${ctx}`,
        },
      });
      if (sessionId) {
        this.trackHookMessage(messageId, sessionId);
      }
      // Inject PTY input for interactive mode (updatedInput only works in headless)
      console.log(`[AskQ-resolve] Button click: hookId=${hookId} option=${optionIndex} label="${selected.label}" multi=${q.multiSelect} totalOpts=${q.options.length} session=${sessionId}`);
      this.injectPtyAnswer(sessionId, optionIndex, q.multiSelect, undefined, q.options.length);
    } catch (err) {
      await adapter.send({ chatId, text: `❌ Failed to resolve: ${err}` });
    }
    return true;
  }

  /** Toggle a multi-select option. Returns the current selection set for re-rendering. */
  toggleMultiSelectOption(hookId: string, optionIndex: number): Set<number> | null {
    const questionData = this.hookQuestionData.get(hookId);
    if (!questionData) return null;
    const q = questionData.questions[0];
    if (!q || optionIndex < 0 || optionIndex >= q.options.length) return null;

    let selected = this.toggledSelections.get(hookId);
    if (!selected) {
      selected = new Set();
      this.toggledSelections.set(hookId, selected);
    }
    if (selected.has(optionIndex)) selected.delete(optionIndex);
    else selected.add(optionIndex);
    return selected;
  }

  /** Get current toggled selections for a hookId */
  getToggledSelections(hookId: string): Set<number> {
    return this.toggledSelections.get(hookId) ?? new Set();
  }

  /** Submit multi-select: resolve hook with all toggled options */
  async resolveMultiSelect(
    hookId: string,
    sessionId: string,
    messageId: string,
    adapter: { editMessage: (chatId: string, messageId: string, msg: any) => Promise<any>; send: (msg: any) => Promise<any> },
    chatId: string,
    coreAvailable: boolean,
  ): Promise<boolean> {
    if (this.resolvedHookIds.has(hookId)) return true;
    if (!coreAvailable) {
      await adapter.send({ chatId, text: '❌ Go Core not available' });
      return true;
    }
    const questionData = this.hookQuestionData.get(hookId);
    if (!questionData) {
      await adapter.send({ chatId, text: '❌ Question data not found' });
      return true;
    }
    const selected = this.toggledSelections.get(hookId) ?? new Set<number>();
    if (selected.size === 0) {
      await adapter.send({ chatId, text: '⚠️ No options selected' });
      return true;
    }

    this.resolvedHookIds.set(hookId, Date.now());
    const q = questionData.questions[0];
    // Join selected labels with comma (per Claude Code docs)
    const selectedLabels = [...selected].sort((a, b) => a - b).map(i => q.options[i]?.label).filter(Boolean);
    const answersValue = selectedLabels.join(',');
    const answers: Record<string, string> = { [q.question]: answersValue };
    const updatedInput = { questions: questionData.questions, answers };

    const resolveBody = JSON.stringify({ decision: 'allow', updated_input: updatedInput });
    console.log(`[AskQ-multisubmit] hookId=${hookId} selected=[${[...selected]}] labels="${answersValue}" session=${sessionId}`);

    try {
      await fetch(`${this.coreUrl}/api/hooks/permission/${hookId}/resolve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: resolveBody,
        signal: AbortSignal.timeout(5000),
      });
      const ctx = questionData.contextSuffix || '';
      this.hookQuestionData.delete(hookId);
      this.toggledSelections.delete(hookId);
      await adapter.editMessage(chatId, messageId, {
        chatId,
        text: `✅ Selected: ${selectedLabels.join(', ')}`,
        buttons: [],
        feishuHeader: { template: 'green', title: `✅ Terminal${ctx}` },
      });
      if (sessionId) {
        this.trackHookMessage(messageId, sessionId);
      }
    } catch (err) {
      await adapter.send({ chatId, text: `❌ Failed to resolve: ${err}` });
    }
    return true;
  }

  /** Handle AskUserQuestion skip — resolve hook with allow + empty answers.
   *  Hook API has no "skip" concept: deny = hard error, allow + empty = graceful skip. */
  async resolveAskQuestionSkip(
    hookId: string,
    sessionId: string,
    messageId: string,
    adapter: { editMessage: (chatId: string, messageId: string, msg: any) => Promise<any>; send: (msg: any) => Promise<any> },
    chatId: string,
    coreAvailable: boolean,
  ): Promise<boolean> {
    if (this.resolvedHookIds.has(hookId)) return true;

    if (!coreAvailable) {
      await adapter.send({ chatId, text: '❌ Go Core not available' });
      return true;
    }
    const questionData = this.hookQuestionData.get(hookId);
    if (!questionData) {
      await adapter.send({ chatId, text: '❌ Question data not found' });
      return true;
    }

    this.resolvedHookIds.set(hookId, Date.now());
    const q = questionData.questions[0];
    const answers: Record<string, string> = { [q.question]: '' };
    const updatedInput = { questions: questionData.questions, answers };

    try {
      await fetch(`${this.coreUrl}/api/hooks/permission/${hookId}/resolve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ decision: 'allow', updated_input: updatedInput }),
        signal: AbortSignal.timeout(5000),
      });
      const ctx = questionData.contextSuffix || '';
      this.hookQuestionData.delete(hookId);
      await adapter.editMessage(chatId, messageId, {
        chatId,
        text: '⏭ Skipped',
        buttons: [],
        feishuHeader: { template: 'grey', title: `⏭ Terminal${ctx}` },
      });
      if (sessionId) {
        this.trackHookMessage(messageId, sessionId);
      }
    } catch (err) {
      await adapter.send({ chatId, text: `❌ Failed to resolve: ${err}` });
    }
    return true;
  }

  /** Handle AskUserQuestion free text reply — resolve hook with text as answer */
  async resolveAskQuestionWithText(
    hookId: string,
    text: string,
    sessionId: string,
    messageId: string,
    adapter: { editMessage: (chatId: string, messageId: string, msg: any) => Promise<any>; send: (msg: any) => Promise<any> },
    chatId: string,
    coreAvailable: boolean,
  ): Promise<boolean> {
    if (this.resolvedHookIds.has(hookId)) return true;

    if (!coreAvailable) {
      await adapter.send({ chatId, text: '❌ Go Core not available' });
      return true;
    }
    const questionData = this.hookQuestionData.get(hookId);
    if (!questionData) {
      await adapter.send({ chatId, text: '❌ Question data not found' });
      return true;
    }

    this.resolvedHookIds.set(hookId, Date.now());
    const q = questionData.questions[0];
    const answers: Record<string, string> = { [q.question]: text };
    const updatedInput = { questions: questionData.questions, answers };

    try {
      await fetch(`${this.coreUrl}/api/hooks/permission/${hookId}/resolve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ decision: 'allow', updated_input: updatedInput }),
        signal: AbortSignal.timeout(5000),
      });
      const ctx = questionData.contextSuffix || '';
      this.hookQuestionData.delete(hookId);
      const preview = text.length > 50 ? text.slice(0, 47) + '...' : text;
      await adapter.editMessage(chatId, messageId, {
        chatId,
        text: `✅ Answer: ${preview}`,
        buttons: [],
        feishuHeader: { template: 'green', title: `✅ Terminal${ctx}` },
      });
      if (sessionId) {
        this.trackHookMessage(messageId, sessionId);
      }
      // Inject PTY input for interactive mode
      const optIdx = q.options?.findIndex((o: { label: string }) => o.label === text) ?? -1;
      if (optIdx >= 0) {
        this.injectPtyAnswer(sessionId, optIdx, q.multiSelect, undefined, q.options.length);
      } else {
        this.injectPtyAnswer(sessionId, 0, false, text);
      }
    } catch (err) {
      await adapter.send({ chatId, text: `❌ Failed to resolve: ${err}` });
    }
    return true;
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
