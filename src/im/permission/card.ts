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
      options: Array<{ label: string; description?: string }>;
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

  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly target: RenderTarget,
    private readonly opts: PermissionCardOptions,
  ) {}

  get requestId(): string { return this.opts.requestId; }

  expectsPlaintextRelay(): boolean {
    return this.customInputPending;
  }

  async send(): Promise<void> {
    const { text, markup } = this.render();
    try {
      this.msgId = await this.adapter.send({
        chatId: this.target.chatId,
        threadId: this.target.threadId,
        text,
        parseMode: 'html',
        replyMarkup: markup,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[perm-send] target=${this.target.channelType}:${this.target.chatId} reason=${reason}\n`);
    }
  }

  async handleCallback(data: string): Promise<void> {
    if (!this.msgId) return;
    if (this.opts.kind === 'generic') {
      const m = data.match(/^perm:([^:]+):(allow|deny|always|learn)$/);
      if (!m || m[1] !== this.opts.requestId) return;
      const verb = m[2] as 'allow' | 'deny' | 'always' | 'learn';
      if (verb === 'learn') return; // future: open URL or expand body
      this.opts.onResolve(verb);
      await this.markResolved(`✅ ${verb}`);
      return;
    }
    // ask
    const optMatch = data.match(/^ask:([^:]+):opt:(\d+)$/);
    if (optMatch) {
      if (optMatch[1] !== this.opts.requestId) return;
      const idx = Number(optMatch[2]);
      if (this.opts.mode === 'single') {
        const label = this.opts.options[idx]?.label ?? '';
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
    if (this.opts.kind !== 'ask') return;
    if (this.opts.mode === 'custom-input' && this.customInputPending) {
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
    const lines = [`❓ <b>${escapeHtml(askOpts.question)}</b>`];
    if (this.customInputPending) lines.push('⌛ 等你输入...');
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
