// src/adapters/im/telegram-html.ts
//
// renderer 产出的 markdown-ish 文本(与 web 共用)→ Telegram HTML entities。
// 全量 HTML 转义在先,agent 可控内容无法注入标签;长 fence(≥8 行)折叠成
// expandable blockquote(Bot API 7.3+,老客户端降级为普通引用块,不炸)。

const EXPANDABLE_MIN_LINES = 8;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(md: string): string {
  // 转义后再做实体替换,分段处理保证 `code` 内部不吃 bold 语法
  const parts = escapeHtml(md).split(/(`[^`\n]*`)/);
  return parts
    .map((p) => {
      if (p.startsWith('`') && p.endsWith('`') && p.length >= 2) {
        return `<code>${p.slice(1, -1)}</code>`;
      }
      return p.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    })
    .join('');
}

export function mdToTelegramHtml(md: string): string {
  const out: string[] = [];
  // fence 块与普通文本交替;语言标签丢弃(TG 的 code 高亮价值低,统一 <pre><code>)
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const before = md.slice(last, m.index).replace(/\n$/, '');
    if (before) out.push(inline(before));
    const body = m[1].replace(/\n$/, '');
    const pre = `<pre><code>${escapeHtml(body)}</code></pre>`;
    out.push(body.split('\n').length >= EXPANDABLE_MIN_LINES ? `<blockquote expandable>${pre}</blockquote>` : pre);
    last = re.lastIndex;
    if (md[last] === '\n') last++;
  }
  const rest = md.slice(last);
  if (rest) out.push(inline(rest));
  return out.join('\n');
}
