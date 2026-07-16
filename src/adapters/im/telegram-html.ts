// src/adapters/im/telegram-html.ts
//
// renderer 产出的 markdown-ish 文本(与 web 共用)→ Telegram HTML entities。
// 全量 HTML 转义在先,agent 可控内容无法注入标签。
//
// 支持的行内标记:`code` / **bold** / *italic* / ~~strike~~ / ||spoiler||。
// 块级:```fence``` → <pre><code class=lang>(语法高亮+复制+角标);
//       `> line` → <blockquote>;`>! line` → <blockquote expandable>。
//
// 两条 Telegram 硬规则塑造了这里的取舍:
//  1. <pre> 内部不渲染任何实体 —— 命令块里的 secret 只能 mask,不能 spoiler。
//  2. <pre> 不能嵌进 <blockquote> —— 长代码用截断 + dashboard 提示,不折叠。

const FENCE_MAX_LINES = 14;
const FENCE_HEAD_LINES = 12;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// U+0000 占位符:抽出 code span 后再跑强调标记,否则 split 会把一对 ** 切到
// 不同碎片里,`**含 code 的粗体**` 永远配不上对(真机实锤)。
// 入口 strip U+0000 —— 占位符不可被内容伪造。
const NUL = String.fromCharCode(0);

/** 行内标记 → HTML。escape 先行;`code` span 内部不再吃其它标记。 */
function inline(md: string): string {
  const codes: string[] = [];
  let s = escapeHtml(md.split(NUL).join(''));
  s = s.replace(/`([^`\n]*)`/g, (_m, c: string) => {
    codes.push(c);
    return `${NUL}${codes.length - 1}${NUL}`;
  });
  s = s
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')   // 先 bold,消耗成对 **
    .replace(/\*([^*\n]+)\*/g, '<i>$1</i>')        // 残留单 * 才是 italic
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/\|\|([^|\n]+)\|\|/g, '<tg-spoiler>$1</tg-spoiler>');
  return s.replace(new RegExp(`${NUL}(\\d+)${NUL}`, 'g'), (_m, i: string) => `<code>${codes[Number(i)]}</code>`);
}

/** 非 fence 段落:按行聚合 blockquote(`> `)/ expandable(`>! `),其余行 inline。 */
function prose(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (/^>! /.test(lines[i])) {
      const buf: string[] = [];
      while (i < lines.length && /^>! /.test(lines[i])) { buf.push(inline(lines[i].slice(3))); i++; }
      out.push(`<blockquote expandable>${buf.join('\n')}</blockquote>`);
    } else if (/^> /.test(lines[i])) {
      const buf: string[] = [];
      while (i < lines.length && /^> /.test(lines[i])) { buf.push(inline(lines[i].slice(2))); i++; }
      out.push(`<blockquote>${buf.join('\n')}</blockquote>`);
    } else {
      out.push(inline(lines[i]));
      i++;
    }
  }
  return out.join('\n');
}

export function mdToTelegramHtml(md: string): string {
  const out: string[] = [];
  const re = /```([^\n]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const before = md.slice(last, m.index).replace(/\n$/, '');
    if (before) out.push(prose(before));
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
  if (rest) out.push(prose(rest));
  return out.join('\n');
}
