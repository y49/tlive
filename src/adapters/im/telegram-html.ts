// src/adapters/im/telegram-html.ts
//
// renderer 产出的 markdown-ish 文本(与 web 共用)→ Telegram HTML entities。
// 全量 HTML 转义在先,agent 可控内容无法注入标签;长 fence(≥8 行)折叠成
// expandable blockquote(Bot API 7.3+,老客户端降级为普通引用块,不炸)。

// TG 不允许 <pre> 嵌进 <blockquote>(真机实证:外层实体被丢,不折叠)。
// 长代码改为截断 + 提示行;完整内容走 web dashboard(IM=快捷面板 web=深度视图)。
const FENCE_MAX_LINES = 14;
const FENCE_HEAD_LINES = 12;

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
  // fence 块与普通文本交替;语言标签保留成 class(TG 显示语言角标+语法高亮+复制钮)
  const re = /```([^\n]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const before = md.slice(last, m.index).replace(/\n$/, '');
    if (before) out.push(inline(before));
    const lang = m[1].trim();
    const cls = lang && /^[\w+-]+$/.test(lang) ? ` class="language-${lang}"` : '';
    const lines = m[2].replace(/\n$/, '').split('\n');
    if (lines.length > FENCE_MAX_LINES) {
      const head = lines.slice(0, FENCE_HEAD_LINES).join('\n');
      out.push(`<pre><code${cls}>${escapeHtml(head)}</code></pre>`);
      out.push(`<i>… +${lines.length - FENCE_HEAD_LINES} more lines — open the dashboard for the full text</i>`);
    } else {
      out.push(`<pre><code${cls}>${escapeHtml(lines.join('\n'))}</code></pre>`);
    }
    last = re.lastIndex;
    if (md[last] === '\n') last++;
  }
  const rest = md.slice(last);
  if (rest) out.push(inline(rest));
  return out.join('\n');
}
