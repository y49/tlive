// src/im/util/html.ts
//
// Shared HTML-escape used by IM renderers (Telegram parseMode='html' + Feishu
// markdown content where < / > / & must not be interpreted). Quotes are NOT
// escaped — neither platform requires it for text/code-block content, and
// over-escaping produces visible &quot; in messages.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
