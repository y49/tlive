// src/kernel/daemon/excerpt.ts
//
// Agent 的 last_assistant_message → 可放进 Telegram <blockquote expandable>
// 的 markdown。产出仍是 markdown,由各 adapter 的渲染器转成自家格式
// (vendor-中立:不得引用任何 CC/Codex 字段,也不得产出 HTML)。
//
// 两条塑造了这里取舍的硬约束:
//  1. TG 的 <blockquote> 不能嵌 <pre> —— 代码块必须降级成逐行 inline code。
//  2. 折叠态只露前 3 行,但展开态必须仍然可读 —— 所以段落换行、粗斜体、
//     行内代码全部保留,绝不压缩 \s+(压了就是一整坨无段落文本)。

/** 代码块保留的行数上限;超出截断并标注。 */
const FENCE_KEEP_LINES = 5;
/** 超预算时首段保留量。 */
const HEAD_BUDGET = 2500;
/** 超预算时尾段保留量 —— agent 的问题/下一步通常在结尾。 */
const TAIL_BUDGET = 800;

/** break preference chain(借鉴 openclaw):段落 → 换行 → 句子 → 空白 → 硬切。
 *  候选位置须过半,否则宁可硬切也不要砍掉过多内容。 */
function breakAt(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const cands = [
    cut.lastIndexOf('\n\n'),
    cut.lastIndexOf('\n'),
    Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('!'), cut.lastIndexOf('?'), cut.lastIndexOf('. ')),
    cut.lastIndexOf(' '),
  ];
  for (const i of cands) if (i > max * 0.5) return cut.slice(0, i + 1).trimEnd();
  return cut;
}

/** 同 breakAt,但从尾部往前找边界。 */
function breakAtEnd(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(-max);
  const cands = [cut.indexOf('\n\n'), cut.indexOf('\n'), cut.indexOf('。'), cut.indexOf(' ')];
  for (const i of cands) if (i >= 0 && i < max * 0.5) return cut.slice(i + 1).trimStart();
  return cut;
}

export function excerptForCard(md: string, budget = 3500): string {
  // 代码块 → 逐行 inline code。整块丢弃会让引导语("Looks like:")变成
  // 没有下文的孤儿句(原型实测踩过)。
  let s = md.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) => {
    const lines = code.replace(/\n$/, '').split('\n').filter((l) => l.trim());
    if (!lines.length) return '';
    const keep = lines.slice(0, FENCE_KEEP_LINES).map((l) => '`' + l.replace(/`/g, "'") + '`').join('\n');
    return lines.length <= FENCE_KEEP_LINES ? keep : `${keep}\n*[+${lines.length - FENCE_KEEP_LINES} more lines]*`;
  });
  // 表格 → 紧凑行(窄屏上管道符会折成一坨)。分隔行连同换行一起删,否则留下空行。
  s = s.replace(/^[ \t]*\|[ \t|:-]+\|[ \t]*\n?/gm, '');
  s = s.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, row: string) =>
    row.split('|').map((c) => c.trim()).filter(Boolean).join(' · '));
  // 标题 → 粗体(TG 无 <h2>)。必须用 [ \t] 而非 \s —— \s 含 \n,会吃掉
  // 标题前的空行,把留白砸没(原型实测踩过)。
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+)$/gm, '**$1**');
  s = s.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ');
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  if (s.length <= budget) return s;
  const head = breakAt(s, HEAD_BUDGET);
  const tail = breakAtEnd(s, TAIL_BUDGET);
  const omitted = s.length - head.length - tail.length;
  return `${head}\n\n⋯ ${omitted} chars omitted ⋯\n\n${tail}`;
}
