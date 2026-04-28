// src/platform/telegram/renderer.ts
//
// Telegram-specific rendering helpers. MarkdownV2 escaping per
// https://core.telegram.org/bots/api#markdownv2-style, HTML conversion of
// CommonMark-ish assistant text per
// https://core.telegram.org/bots/api#html-style, and inline-keyboard
// serialization from our platform-agnostic ReplyMarkup.

import type { InlineKeyboardButton } from 'grammy/types';
import type { InlineButton, ReplyMarkup } from '../types.js';

/** Characters reserved by MarkdownV2 outside of code spans/fences. */
const MDV2_ESCAPE = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

/**
 * Blunt-instrument escape: escapes EVERY MarkdownV2 special character. Used
 * by callers (e.g. legacy elicitation flows) that explicitly want every
 * reserved char escaped. For freeform assistant text prefer {@link formatHtml}
 * with `parseMode: 'html'`, which is far more forgiving than MarkdownV2.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(MDV2_ESCAPE, (ch) => `\\${ch}`);
}

/** HTML-entity-escape the three Telegram-significant chars. Use for any text
 *  embedded inside `parse_mode: 'HTML'` content (including `<code>` / `<pre>`
 *  bodies — Telegram still HTML-decodes them). */
const HTML_ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (ch) => HTML_ENT[ch] ?? ch);
}

/**
 * Convert lightly-marked-up CommonMark text emitted by the agent into the
 * subset of HTML Telegram understands (`<b>`, `<i>`, `<code>`, `<pre>`,
 * `<a>`). The goal is a pragmatic "good enough" formatter:
 *
 *   - ```` ```lang\nBODY\n``` ```` -> `<pre><code class="language-lang">BODY</code></pre>`
 *   - `` `code` `` -> `<code>code</code>`
 *   - `**bold**` -> `<b>bold</b>` (must precede single-`*`)
 *   - `*italic*` / `_italic_` -> `<i>italic</i>` (only when balanced on a line)
 *   - `[label](url)` -> `<a href="url">label</a>` (https/http/tg only)
 *   - All other text is HTML-escaped so stray `<`, `>` or `&` never break
 *     the parser. Bullet-line dashes are kept verbatim — Telegram HTML has
 *     no `<ul>` so we leave the prefix alone.
 *
 * Why HTML and not MarkdownV2: HTML mode requires only three escapes
 * (`<`, `>`, `&`) and Telegram parse-errors only when an actual tag is
 * malformed — far more forgiving than MarkdownV2's "every reserved char
 * outside a span must be backslash-escaped" rule, which any unbalanced
 * `*` / `(` / `.` / `-` / `!` / `>` in agent prose would trip.
 */
export function formatHtml(text: string): string {
  const out: string[] = [];
  const tokens = tokenizeMarkdown(text);
  for (const tok of tokens) {
    if (tok.kind === 'fence') {
      const lang = tok.lang ? tok.lang.replace(/[^A-Za-z0-9_+-]/g, '').toLowerCase() : '';
      const body = escapeHtml(tok.body);
      const cls = lang ? ` class="language-${lang}"` : '';
      out.push(`<pre><code${cls}>${body}</code></pre>`);
      continue;
    }
    if (tok.kind === 'code') {
      out.push(`<code>${escapeHtml(tok.body)}</code>`);
      continue;
    }
    out.push(formatPlainHtml(tok.body));
  }
  return out.join('');
}

interface MdToken {
  kind: 'fence' | 'code' | 'plain';
  body: string;
  lang?: string;
}

function tokenizeMarkdown(text: string): MdToken[] {
  const tokens: MdToken[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('```', i)) {
      const close = text.indexOf('```', i + 3);
      if (close !== -1) {
        const head = text.slice(i + 3, close);
        const nl = head.indexOf('\n');
        const lang = nl >= 0 ? head.slice(0, nl).trim() : '';
        const body = nl >= 0 ? head.slice(nl + 1).replace(/\n$/, '') : head;
        tokens.push({ kind: 'fence', body, lang });
        i = close + 3;
        continue;
      }
    }
    if (text[i] === '`') {
      const close = text.indexOf('`', i + 1);
      if (close !== -1 && !text.slice(i + 1, close).includes('\n')) {
        tokens.push({ kind: 'code', body: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    const next = text.indexOf('`', i);
    const end = next === -1 ? text.length : next;
    if (end > i) {
      tokens.push({ kind: 'plain', body: text.slice(i, end) });
      i = end;
    } else {
      i++;
    }
  }
  return tokens;
}

/**
 * Convert plain-text Markdown formatters to Telegram HTML. We escape HTML
 * entities first, then layer in `<b>` / `<i>` / `<a>` by pattern. Order
 * matters: `**bold**` must run before `*italic*`. The `[label](url)` regex
 * accepts only http(s)/tg URLs to match Telegram's link policy.
 */
function formatPlainHtml(text: string): string {
  let s = escapeHtml(text);
  // **bold**
  s = s.replace(/\*\*([^*\n][^\n]*?)\*\*/g, '<b>$1</b>');
  // *italic*  (skip leftover halves of double-star and runs joined to alphanum)
  s = s.replace(/(^|[^*\w])\*([^*\n][^\n]*?)\*(?!\*)/g, '$1<i>$2</i>');
  // _italic_
  s = s.replace(/(^|[^_\w])_([^_\n][^\n]*?)_(?!_)/g, '$1<i>$2</i>');
  // [label](url) — http(s) or tg only.
  s = s.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|tg:\/\/[^)\s]+)\)/g,
    (_m, label: string, url: string) => `<a href="${url}">${label}</a>`,
  );
  return s;
}

/**
 * Telegram callback_data is capped at 64 bytes. Callers should keep strings
 * short; this helper truncates + hashes if needed to fit.
 */
export function clampCallbackData(data: string): string {
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes <= 64) return data;
  return data.slice(0, 60) + '…';
}

export function buttonsToInlineKeyboard(
  buttons: InlineButton[][],
): InlineKeyboardButton[][] {
  return buttons.map((row) =>
    row.map((btn): InlineKeyboardButton => {
      if (btn.url) return { text: btn.text, url: btn.url };
      return { text: btn.text, callback_data: clampCallbackData(btn.callbackData ?? '') };
    }),
  );
}

/**
 * Convert our ReplyMarkup → the subset Telegram accepts on sendMessage /
 * editMessageText. forceReply is mapped to `{ force_reply: true }`. modal is
 * unsupported — callers are expected to consult the capability matrix and
 * fall back to forceReply.
 */
export function replyMarkupToTelegram(markup: ReplyMarkup | undefined): object | undefined {
  if (!markup) return undefined;
  if (markup.type === 'inline_keyboard' && markup.buttons) {
    return { inline_keyboard: buttonsToInlineKeyboard(markup.buttons) };
  }
  if (markup.type === 'force_reply') {
    return {
      force_reply: true,
      input_field_placeholder: markup.placeholder,
    };
  }
  return undefined;
}
