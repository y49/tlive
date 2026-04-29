// src/im/permission/card.ts
//
// PermissionCard — renders generic-permission and AskUserQuestion (single /
// multi / custom-input) cards. Callback strings use a local format the class
// understands; T6b's frontend/router wiring translates between this and the
// existing perm:<verb>:<sid>:<reqId> router format.

import type { PlatformAdapter, ReplyMarkup, InlineButton } from '../../platform/types.js';
import type { RenderTarget } from '../render-target.js';
import { escapeHtml } from '../util/html.js';

export type PermissionCardOptions =
  | {
      kind: 'generic';
      requestId: string;
      toolName: string;
      toolInput: unknown;
      onResolve: (decision: 'allow' | 'deny' | 'always') => void;
    }
  | {
      kind: 'ask';
      requestId: string;
      mode: 'single' | 'multi' | 'custom-input';
      question: string;
      /** Optional short chip/tag (max ~12 chars per Claude SDK convention). */
      header?: string;
      options: Array<{ label: string; description?: string; preview?: string }>;
      onResolve: (chosen: string[]) => void;
    };

function jsonPreview(input: unknown, max = 500): string {
  try {
    return escapeHtml(JSON.stringify(input, null, 2).slice(0, max));
  } catch {
    return '';
  }
}

export class PermissionCard {
  private msgId: string | null = null;
  private selected = new Set<number>();
  private customInputPending = false;
  private resolved = false;
  private fallbackPending = false;

  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly target: RenderTarget,
    private readonly opts: PermissionCardOptions,
  ) {}

  get requestId(): string { return this.opts.requestId; }

  expectsPlaintextRelay(): boolean {
    return this.customInputPending;
  }

  isPermFallbackPending(): boolean { return this.fallbackPending; }

  async resolveFromKeyword(verb: 'allow' | 'deny' | 'always'): Promise<void> {
    if (this.resolved) return;
    if (this.opts.kind !== 'generic') return;
    this.resolved = true;
    this.fallbackPending = false;
    this.opts.onResolve(verb);
    // Don't try to edit — the card never landed on the wire (or msgId may be empty).
    // The fallback hint message stays as-is in the chat.
  }

  /**
   * Switch an ask card to its resolved visual state, replacing the keyboard
   * with a one-line summary of the user's choice. Drives both telegram and
   * feishu via adapter.edit (same path as the in-class markResolved). No-op
   * for generic-permission cards or already-resolved ask cards.
   */
  async markResolvedAsk(chosen: string[]): Promise<void> {
    if (this.opts.kind !== 'ask') return;
    if (this.resolved) return;
    this.resolved = true;
    if (!this.msgId) return;
    const summary = chosen.length === 0
      ? '(已跳过)'
      : `已选: ${chosen.join('、')}`;
    const text = `❓ <b>${escapeHtml(this.opts.question)}</b>\n\n✅ ${escapeHtml(summary)}`;
    try {
      await this.adapter.edit(this.msgId, this.target.chatId, text, undefined, 'html');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ask-card] resolved-edit failed target=${this.target.channelType}:${this.target.chatId} reason=${reason}\n`);
    }
  }

  async send(): Promise<void> {
    const { text, markup } = this.render();
    const sendOnce = () => this.adapter.send({
      chatId: this.target.chatId,
      threadId: this.target.threadId,
      text,
      parseMode: 'html',
      replyMarkup: markup,
    });

    try {
      this.msgId = await sendOnce();
      return;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[perm-send] retry-after target=${this.target.channelType}:${this.target.chatId} reason=${reason}\n`);
    }

    await new Promise((r) => setTimeout(r, 1000));

    try {
      this.msgId = await sendOnce();
      return;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[perm-send] fatal-fallback target=${this.target.channelType}:${this.target.chatId} reason=${reason}\n`);
    }

    // Final fallback: plaintext hint (only meaningful for generic kind).
    if (this.opts.kind === 'generic') {
      try {
        await this.adapter.send({
          chatId: this.target.chatId,
          threadId: this.target.threadId,
          text: `⚠️ Permission needed for ${this.opts.toolName}; daemon couldn't send card. Reply 'allow' or 'deny'.`,
        });
        this.fallbackPending = true;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[perm-send] fallback-text-failed target=${this.target.channelType}:${this.target.chatId} reason=${reason}\n`);
      }
    }
  }

  async handleCallback(data: string): Promise<void> {
    if (this.resolved) return;
    if (!this.msgId) return;
    if (this.opts.kind === 'generic') {
      const m = data.match(/^perm:([^:]+):(allow|deny|always|learn)$/);
      if (!m || m[1] !== this.opts.requestId) return;
      const verb = m[2] as 'allow' | 'deny' | 'always' | 'learn';
      if (verb === 'learn') return; // future: open URL or expand body
      this.resolved = true;
      this.opts.onResolve(verb);
      await this.markResolved(`✅ ${verb}`);
      return;
    }
    // ask
    const optMatch = data.match(/^ask:([^:]+):opt:(\d+)$/);
    if (optMatch) {
      if (optMatch[1] !== this.opts.requestId) return;
      const idx = Number(optMatch[2]);
      if (this.opts.mode === 'single' || this.opts.mode === 'custom-input') {
        // custom-input mode also resolves immediately on a direct option click
        // — the "✏️ 自己输入" button is the *fallback*, not the only path.
        const label = this.opts.options[idx]?.label ?? '';
        this.resolved = true;
        this.opts.onResolve([label]);
        await this.markResolved(`✅ ${escapeHtml(label)}`);
        return;
      }
      // multi: toggle and re-edit.
      if (this.selected.has(idx)) this.selected.delete(idx);
      else this.selected.add(idx);
      await this.editKeyboard();
      return;
    }
    const askOpts = this.opts as Extract<PermissionCardOptions, { kind: 'ask' }>;
    const confirmMatch = data.match(/^ask:([^:]+):confirm$/);
    if (confirmMatch) {
      if (confirmMatch[1] !== askOpts.requestId) return;
      const labels = [...this.selected]
        .sort((a, b) => a - b)
        .map(i => askOpts.options[i]?.label ?? '');
      this.resolved = true;
      askOpts.onResolve(labels);
      await this.markResolved(labels.length > 0 ? `✅ ${escapeHtml(labels.join(', '))}` : '✅ (空提交)');
      return;
    }
    const customMatch = data.match(/^ask:([^:]+):custom$/);
    if (customMatch) {
      if (customMatch[1] !== askOpts.requestId) return;
      this.customInputPending = true;
      await this.editKeyboard();
    }
  }

  /** Called by frontend's plaintext-relay path when user replies with text. */
  async resolveWithPlaintext(text: string): Promise<void> {
    if (this.resolved) return;
    if (this.opts.kind !== 'ask') return;
    if (this.opts.mode === 'custom-input' && this.customInputPending) {
      this.resolved = true;
      this.opts.onResolve([text]);
      await this.markResolved(`✅ ${escapeHtml(text)}`);
      return;
    }
    if (this.opts.mode === 'single') {
      const labels = this.opts.options.map(o => o.label);
      const trimmed = text.trim();
      const asInt = Number(trimmed);
      let chosen: string | undefined;
      if (Number.isInteger(asInt) && asInt >= 1 && asInt <= labels.length) {
        chosen = labels[asInt - 1];
      } else {
        chosen = labels.find(l => l.toLowerCase() === trimmed.toLowerCase())
          ?? labels.find(l => l.toLowerCase().includes(trimmed.toLowerCase()));
      }
      if (chosen) {
        this.resolved = true;
        this.opts.onResolve([chosen]);
        await this.markResolved(`✅ ${escapeHtml(chosen)}`);
      }
      return;
    }
    if (this.opts.mode === 'multi') {
      const parts = text.split(/[,，]/).map(s => s.trim()).filter(Boolean);
      const labels = this.opts.options.map(o => o.label);
      const chosen: string[] = [];
      for (const p of parts) {
        const asInt = Number(p);
        if (Number.isInteger(asInt) && asInt >= 1 && asInt <= labels.length) {
          chosen.push(labels[asInt - 1]);
          continue;
        }
        const match = labels.find(l => l.toLowerCase() === p.toLowerCase())
          ?? labels.find(l => l.toLowerCase().includes(p.toLowerCase()));
        if (match) chosen.push(match);
      }
      if (chosen.length > 0) {
        this.resolved = true;
        this.opts.onResolve(chosen);
        await this.markResolved(`✅ ${escapeHtml(chosen.join(', '))}`);
      }
    }
  }

  private render(): { text: string; markup: ReplyMarkup } {
    if (this.opts.kind === 'generic') {
      const text =
        `🔐 <b>Permission</b>: <code>${escapeHtml(this.opts.toolName)}</code>\n` +
        `<pre>${jsonPreview(this.opts.toolInput)}</pre>`;
      const buttons: InlineButton[][] = [
        [
          { text: '✅ Allow', callbackData: `perm:${this.opts.requestId}:allow` },
          { text: '❌ Deny', callbackData: `perm:${this.opts.requestId}:deny` },
        ],
        [
          { text: '🔄 Always', callbackData: `perm:${this.opts.requestId}:always` },
          { text: '💡 Learn', callbackData: `perm:${this.opts.requestId}:learn` },
        ],
      ];
      return { text, markup: { type: 'inline_keyboard', buttons } };
    }
    // ask
    const askOpts = this.opts as Extract<PermissionCardOptions, { kind: 'ask' }>;
    const headerChip = askOpts.header ? ` <i>[${escapeHtml(askOpts.header)}]</i>` : '';
    const lines = [`❓ <b>${escapeHtml(askOpts.question)}</b>${headerChip}`];
    if (askOpts.mode === 'multi') lines.push('<i>多选 — 点选/取消,然后确认提交</i>');
    if (this.customInputPending) lines.push('⌛ 等你输入...');
    // Append per-option descriptions inline below the question (compact, monospace).
    const optsWithDesc = askOpts.options.filter((o) => o.description);
    if (!this.customInputPending && optsWithDesc.length > 0) {
      lines.push('');
      askOpts.options.forEach((o, i) => {
        if (o.description) {
          lines.push(`  <b>${i + 1}. ${escapeHtml(o.label)}</b> — ${escapeHtml(o.description)}`);
        } else {
          lines.push(`  <b>${i + 1}. ${escapeHtml(o.label)}</b>`);
        }
      });
    }
    const buttons: InlineButton[][] = [];
    if (!this.customInputPending) {
      askOpts.options.forEach((o, i) => {
        const prefix = askOpts.mode === 'multi' ? (this.selected.has(i) ? '✅ ' : '⬜ ') : '';
        buttons.push([{
          text: `${prefix}${o.label}`,
          callbackData: `ask:${askOpts.requestId}:opt:${i}`,
        }]);
      });
      if (askOpts.mode === 'multi') {
        buttons.push([{
          text: `✓ 确认提交 (已选 ${this.selected.size})`,
          callbackData: `ask:${askOpts.requestId}:confirm`,
        }]);
      }
      if (askOpts.mode === 'custom-input') {
        buttons.push([{
          text: '✏️ 自己输入(发文本)',
          callbackData: `ask:${askOpts.requestId}:custom`,
        }]);
      }
    }
    return { text: lines.join('\n'), markup: { type: 'inline_keyboard', buttons } };
  }

  private async editKeyboard(): Promise<void> {
    if (!this.msgId) return;
    const { text, markup } = this.render();
    try {
      await this.adapter.edit(this.msgId, this.target.chatId, text, markup, 'html');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[perm-edit] target=${this.target.channelType}:${this.target.chatId} reason=${reason}\n`);
    }
  }

  private async markResolved(suffix: string): Promise<void> {
    if (!this.msgId) return;
    const baseText = this.opts.kind === 'generic'
      ? `🔐 <b>Permission</b>: ${escapeHtml(this.opts.toolName)} — ${suffix}`
      : `❓ <b>${escapeHtml(this.opts.question)}</b>\n${suffix}`;
    try {
      await this.adapter.edit(this.msgId, this.target.chatId, baseText, undefined, 'html');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[perm-resolve] target=${this.target.channelType}:${this.target.chatId} reason=${reason}\n`);
    }
  }
}
