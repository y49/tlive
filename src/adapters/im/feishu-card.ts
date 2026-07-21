// src/adapters/im/feishu-card.ts
//
// renderer 产出的 markdown-ish 文本(与 web/TG 共用)→ 飞书 card JSON 2.0
// elements。与 telegram-html.ts 同一角色:渠道方言的转换只住在 adapter 里,
// kernel 的卡片 body 保持渠道中立。
//
// Card JSON 2.0(官方文档查证,2026-07-21;客户端 7.20+,旧客户端降级为
// 升级提示而非乱版):markdown 元素原生支持 **bold** *italic* ~~strike~~、
// 行内 `code`、```fence```(60+ 语言)、`> ` 引用、表格、嵌套列表 —— 1.0
// 时代的降级(行内 code→bold、引用去标记)全部退役,转换近乎直通。
//
// 仍然保留的处理:
//   - `>! `(TG 的 expandable 引用)→ 2.0 的 `> ` 引用块。collapsible_panel
//     弃用:1.0 形状真机渲染失败(面板整个不出现),引用块可见且原生。
//   - ||spoiler|| → 去标记(飞书无 spoiler;secrets 走 mask 不走 spoiler)。
//   - prose 转义 & < > 为数字实体 —— 飞书 markdown 认 <at>/<text_tag>/<link>
//     标签,agent 可控内容不得注入(与 TG escape-first 同纪律)。code span
//     与 fence 内也转义 —— tag-inside-code 是否解析未真机验,宁可实体也不赌。

/** 数字实体转义,防 <at>/<text_tag> 注入。& 必须最先换。 */
function escapeFeishu(s: string): string {
  return s.replace(/&/g, '&#38;').replace(/</g, '&#60;').replace(/>/g, '&#62;');
}

/** 行内处理:整行转义(含 code span 内容——见文件头)+ spoiler 去标记。
 *  2.0 原生认得行内 code、bold 等标记,标记本身原样保留。 */
function inline(md: string): string {
  return escapeFeishu(md).replace(/\|\|([^|\n]+)\|\|/g, '$1');
}

type FeishuElement = Record<string, unknown>;

const mdEl = (content: string): FeishuElement => ({ tag: 'markdown', content });

/** 非 fence 段:`>! ` 与 `> ` 都归一成 2.0 引用块,其余行 inline。 */
function prose(text: string, out: FeishuElement[]): void {
  const lines = text.split('\n');
  const buf: string[] = [];
  for (const line of lines) {
    if (/^>! /.test(line)) buf.push(`> ${inline(line.slice(3))}`);
    else if (/^> /.test(line)) buf.push(`> ${inline(line.slice(2))}`);
    else buf.push(inline(line));
  }
  // 按内容而非行数判空:真实 body 常以 \n 开头(标题留白),不产出空元素
  // (content 必填,空元素整卡可能被拒)。
  const c = buf.join('\n');
  if (c.trim()) out.push(mdEl(c));
}

/** markdown-ish body → 飞书 card 2.0 elements。fence 独立成元素(语法高亮),
 *  空 body 也保证至少一个元素(零元素卡片可能被 API 拒收,保守起见)。 */
export function mdToFeishuElements(md: string): FeishuElement[] {
  const out: FeishuElement[] = [];
  const re = /```([^\n]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const before = md.slice(last, m.index).replace(/\n$/, '');
    if (before.trim()) prose(before, out);
    const lang = m[1].trim();
    const fence = lang && /^[\w+-]+$/.test(lang) ? `\`\`\`${lang}` : '```';
    out.push(mdEl(`${fence}\n${escapeFeishu(m[2].replace(/\n$/, ''))}\n\`\`\``));
    last = re.lastIndex;
    if (md[last] === '\n') last++;
  }
  const rest = md.slice(last);
  if (rest.trim()) prose(rest, out);
  if (!out.length) out.push(mdEl(' '));
  return out;
}
