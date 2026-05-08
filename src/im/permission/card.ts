// src/im/permission/card.ts
//
// PermissionCard — renders generic-permission and AskUserQuestion (single /
// multi / custom-input) cards. Callback strings use a local format the class
// understands; T6b's frontend/router wiring translates between this and the
// existing perm:<verb>:<sid>:<reqId> router format.

import type { PlatformAdapter, ReplyMarkup, InlineButton } from '../../platform/types.js';
import type { RenderTarget } from '../render-target.js';
import type { PermissionCategory } from '../../runtime/types.js';
import { escapeHtml } from '../util/html.js';

export type PermissionCardOptions =
  | {
      kind: 'generic';
      requestId: string;
      toolName: string;
      toolInput: unknown;
      category?: PermissionCategory;
      diffPreview?: { from: string; to: string; added: number; removed: number; path?: string };
      risk?: 'low' | 'medium' | 'high';
      onResolve: (decision: 'allow' | 'deny' | 'always') => void;
    }
  | {
      kind: 'ask';
      requestId: string;
      // v3.2.4: replace 'mode' string with two orthogonal booleans so
      // `multi: true, allowCustom: true` is expressible (was lost in the
      // old 3-mode union which treated multi/custom as mutually exclusive).
      multi: boolean;
      allowCustom: boolean;
      question: string;
      /** Optional short chip/tag (max ~12 chars per Claude SDK convention). */
      header?: string;
      options: Array<{ label: string; description?: string; preview?: string }>;
      onResolve: (chosen: string[]) => void;
    };

const CONTENT_MAX_LINES = 30;
const CONTENT_MAX_CHARS = 1500;

/** Truncate content to first N lines / M chars; append note if clipped. */
function truncateContent(text: string): string {
  let clipped = text.length > CONTENT_MAX_CHARS ? text.slice(0, CONTENT_MAX_CHARS) : text;
  const lines = clipped.split('\n');
  if (lines.length > CONTENT_MAX_LINES) clipped = lines.slice(0, CONTENT_MAX_LINES).join('\n');
  const totalLines = text.split('\n').length;
  const shownLines = clipped.split('\n').length;
  const note = shownLines < totalLines ? `\n<i>...还有 ${totalLines - shownLines} 行</i>` : '';
  return escapeHtml(clipped) + note;
}

/** Extract the most informative 1-2 fields from a toolInput for generic tools. */
function genericPreview(toolName: string, input: unknown): string {
  if (input == null || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  const KEY_HINTS: Record<string, string[]> = {
    WebFetch: ['url'],
    WebSearch: ['query'],
    Read: ['file_path'],
    Grep: ['pattern', 'path'],
    Glob: ['pattern'],
    LS: ['path'],
  };
  const candidates = KEY_HINTS[toolName] ?? ['url', 'query', 'pattern', 'path', 'file_path', 'command'];
  const parts: string[] = [];
  for (const k of candidates) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) {
      parts.push(`<b>${escapeHtml(k)}</b>: <code>${escapeHtml(v.slice(0, 200))}</code>`);
      if (parts.length >= 2) break;
    }
  }
  return parts.join('\n');
}

/** Build the body text for a generic-kind permission card based on category. */
function buildGenericBody(opts: Extract<PermissionCardOptions, { kind: 'generic' }>): string {
  const category = opts.category ?? 'generic';

  if (category === 'file-edit') {
    const dp = opts.diffPreview;
    if (!dp) return `🔐 <b>Permission</b>: <code>${escapeHtml(opts.toolName)}</code>`;
    const shortPath = dp.path
      ? dp.path.split('/').slice(-2).join('/')
      : '(unknown path)';
    const isNew = dp.from === '';
    const verb = opts.toolName === 'Write' ? '✏ Write' : opts.toolName === 'MultiEdit' ? '✏ MultiEdit' : '✏ Edit';
    const header = `${verb} — <code>${escapeHtml(shortPath)}</code>`;
    let diff: string;
    if (isNew) {
      const lineCount = dp.to ? dp.to.split('\n').length : 0;
      diff = `<i>+ ${lineCount} 行 (新文件)</i>\n<pre>${truncateContent(dp.to)}</pre>`;
    } else {
      diff = `<i>+${dp.added} / -${dp.removed}</i>`;
      if (dp.from) diff += `\n<pre>${truncateContent(dp.from)}</pre>`;
    }
    return `${header}\n${diff}`;
  }

  if (category === 'exec') {
    const input = opts.toolInput as Record<string, unknown> | null ?? {};
    const cmd = typeof input === 'object' && input !== null
      ? String((input as Record<string, unknown>).command ?? '')
      : '';
    const risk = opts.risk ?? 'low';
    const riskTag = risk === 'high' ? ' ⚠️ high risk' : risk === 'medium' ? ' · medium risk' : ' · low risk';
    return `🖥 <b>Bash</b>${riskTag}\n<pre>$ ${escapeHtml(cmd.slice(0, 500))}</pre>`;
  }

  // generic fallback: tool name + key fields (no JSON dump)
  const preview = genericPreview(opts.toolName, opts.toolInput);
  const header = `🔐 <b>Permission</b>: <code>${escapeHtml(opts.toolName)}</code>`;
  return preview ? `${header}\n${preview}` : header;
}

export class PermissionCard {
  private msgId: string | null = null;
  private selected = new Set<number>();
  private customs: string[] = []; // v3.2.4: free-text custom answers (multi+custom path)
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
      : `已选: ${chosen.map((c) => escapeHtml(c)).join('、')}`;
    const text = `❓ <b>${escapeHtml(this.opts.question)}</b>\n\n✅ ${summary}`;
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
    // ask — v3.2.4: 4 mode combinations driven by (multi, allowCustom):
    //   F,F (single):       option click → resolve immediately
    //   F,T (single+custom): option click → resolve, OR "✏️ 自定义" → plaintext → resolve
    //   T,F (multi):         option click → toggle, "✓ 提交" / "❌ 跳过"
    //   T,T (multi+custom):  option click → toggle, "✏️ 加自定义" → plaintext → push to customs[],
    //                        "✓ 提交" / "❌ 跳过" — confirm sends [...toggled, ...customs]
    const askOpts = this.opts as Extract<PermissionCardOptions, { kind: 'ask' }>;
    const optMatch = data.match(/^ask:([^:]+):opt:(\d+)$/);
    if (optMatch) {
      if (optMatch[1] !== askOpts.requestId) return;
      const idx = Number(optMatch[2]);
      if (!askOpts.multi) {
        // single (with or without allowCustom): direct click resolves immediately.
        const label = askOpts.options[idx]?.label ?? '';
        this.resolved = true;
        askOpts.onResolve([label]);
        await this.markResolved(`✅ ${escapeHtml(label)}`);
        return;
      }
      // multi: toggle and re-edit.
      if (this.selected.has(idx)) this.selected.delete(idx);
      else this.selected.add(idx);
      await this.editKeyboard();
      return;
    }
    const confirmMatch = data.match(/^ask:([^:]+):confirm$/);
    if (confirmMatch) {
      if (confirmMatch[1] !== askOpts.requestId) return;
      if (!askOpts.multi) return; // confirm button only exists for multi
      const toggledLabels = [...this.selected]
        .sort((a, b) => a - b)
        .map(i => askOpts.options[i]?.label ?? '')
        .filter(Boolean);
      const all = [...toggledLabels, ...this.customs];
      this.resolved = true;
      askOpts.onResolve(all);
      const summary = all.length > 0 ? `✅ ${all.map((c) => escapeHtml(c)).join(', ')}` : '✅ (空提交)';
      await this.markResolved(summary);
      return;
    }
    const skipMatch = data.match(/^ask:([^:]+):skip$/);
    if (skipMatch) {
      if (skipMatch[1] !== askOpts.requestId) return;
      this.resolved = true;
      askOpts.onResolve([]);
      await this.markResolved('✅ (已跳过)');
      return;
    }
    const customMatch = data.match(/^ask:([^:]+):custom$/);
    if (customMatch) {
      if (customMatch[1] !== askOpts.requestId) return;
      if (!askOpts.allowCustom) return; // custom button only when allowed
      this.customInputPending = true;
      await this.editKeyboard();
    }
  }

  /** Called by frontend's plaintext-relay path when user replies with text. */
  async resolveWithPlaintext(text: string): Promise<void> {
    if (this.resolved) return;
    if (this.opts.kind !== 'ask') return;
    const askOpts = this.opts;

    // v3.2.4: customInputPending is set when user clicked the [✏️ 自定义]
    // button and we're awaiting their text.
    if (this.customInputPending) {
      this.customInputPending = false;
      const trimmed = text.trim();
      if (askOpts.multi) {
        // Multi+custom: push the text to customs[], re-edit keyboard.
        // User can keep toggling, add more customs, then confirm.
        if (trimmed) this.customs.push(trimmed);
        await this.editKeyboard();
        return;
      }
      // Single+custom: resolve immediately with the typed text.
      this.resolved = true;
      askOpts.onResolve([trimmed]);
      await this.markResolved(`✅ ${escapeHtml(trimmed)}`);
      return;
    }

    // No custom-input pending — interpret plaintext as option keyword/index match.
    if (!askOpts.multi) {
      const labels = askOpts.options.map(o => o.label);
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
        askOpts.onResolve([chosen]);
        await this.markResolved(`✅ ${escapeHtml(chosen)}`);
      }
      return;
    }
    // multi: comma-separated keywords match labels
    const parts = text.split(/[,,]/).map(s => s.trim()).filter(Boolean);
    const labels = askOpts.options.map(o => o.label);
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
      askOpts.onResolve(chosen);
      await this.markResolved(`✅ ${chosen.map((c) => escapeHtml(c)).join(', ')}`);
    }
  }

  private render(): { text: string; markup: ReplyMarkup } {
    if (this.opts.kind === 'generic') {
      const text = buildGenericBody(this.opts);
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
    // ask — v3.2.4: 4 mode combinations from (multi, allowCustom)
    const askOpts = this.opts as Extract<PermissionCardOptions, { kind: 'ask' }>;
    const headerChip = askOpts.header ? ` <i>[${escapeHtml(askOpts.header)}]</i>` : '';
    const lines = [`❓ <b>${escapeHtml(askOpts.question)}</b>${headerChip}`];
    if (askOpts.multi) lines.push('<i>多选 — 点选/取消,然后确认提交</i>');
    if (this.customInputPending) lines.push('⌛ 等你输入...');
    // Show added customs (multi+custom) as a "已加自定义" line so user
    // sees what they've added even if they keep toggling.
    if (askOpts.multi && this.customs.length > 0) {
      lines.push(`✏️ 已加自定义: ${this.customs.map((c) => escapeHtml(c)).join('、')}`);
    }
    // Append per-option descriptions
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
      // Option buttons (with toggle prefix in multi mode)
      askOpts.options.forEach((o, i) => {
        const prefix = askOpts.multi ? (this.selected.has(i) ? '✅ ' : '⬜ ') : '';
        buttons.push([{
          text: `${prefix}${o.label}`,
          callbackData: `ask:${askOpts.requestId}:opt:${i}`,
        }]);
      });
      // Custom-input button (when allowed)
      if (askOpts.allowCustom) {
        const label = askOpts.multi ? '✏️ 加自定义(发文本)' : '✏️ 自己输入(发文本)';
        buttons.push([{
          text: label,
          callbackData: `ask:${askOpts.requestId}:custom`,
        }]);
      }
      // Submit row (multi only) — confirm + skip
      if (askOpts.multi) {
        const totalChosen = this.selected.size + this.customs.length;
        buttons.push([
          {
            text: `✓ 提交 (${totalChosen})`,
            callbackData: `ask:${askOpts.requestId}:confirm`,
          },
          {
            text: '❌ 跳过',
            callbackData: `ask:${askOpts.requestId}:skip`,
          },
        ]);
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
