// src/adapters/im/feishu-card.ts
//
// renderer 产出的 markdown-ish 文本(与 web/TG 共用)→ 飞书 card JSON 2.0
// elements。与 telegram-html.ts 同一角色:渠道方言的转换只住在 adapter 里,
// kernel 的卡片 body 保持渠道中立。
//
// Card JSON 2.0(官方文档 + 真机验证,2026-07-21;客户端 7.20+,旧客户端
// 降级为升级提示):markdown 原生支持 **bold** *italic* ~~strike~~、行内
// `code`、```fence```、`> ` 引用、表格 —— 1.0 时代的降级全部退役。
//
// 转义纪律(真机证据修正版):
//   - prose 转义 & < > 为数字实体 —— 飞书 markdown 认 <at>/<text_tag> 标签,
//     agent 可控内容不得注入(与 TG escape-first 同纪律)。
//   - code span 与 fence 内 **不转义**:真机实锤 2.0 的 code 内容是惰性的
//     (实体 &#60; 原样字面显示 ⟹ 既不解码实体也不解析标签),转义只会把
//     实体喂给用户看。NUL 占位符抽取防 prose 转义误伤(TG 同款方案)。
//   - `>! `(TG 的 expandable)→ `> ` 引用块,且裁剪到 QUOTE_MAX_LINES 行
//     (飞书没有能用的折叠容器;不裁剪=长摘录刷屏,真机反馈"太丑")。
//   - ||spoiler|| → 去标记(飞书无 spoiler;secrets 走 mask 不走 spoiler)。

const NUL = String.fromCharCode(0);
const QUOTE_MAX_LINES = 8;

/** 数字实体转义,防 <at>/<text_tag> 注入。& 必须最先换。 */
function escapeFeishu(s: string): string {
  return s.replace(/&/g, '&#38;').replace(/</g, '&#60;').replace(/>/g, '&#62;');
}

/** 行内处理:code span 抽占位符(内容惰性,原样保留),其余 prose 转义,
 *  spoiler 去标记,最后回填 code span。 */
function inline(md: string): string {
  const codes: string[] = [];
  let s = md.split(NUL).join('');
  s = s.replace(/`([^`\n]*)`/g, (_m, c: string) => {
    codes.push(c);
    return `${NUL}${codes.length - 1}${NUL}`;
  });
  s = escapeFeishu(s).replace(/\|\|([^|\n]+)\|\|/g, '$1');
  return s.replace(new RegExp(`${NUL}(\\d+)${NUL}`, 'g'), (_m, i: string) => `\`${codes[Number(i)]}\``);
}

type FeishuElement = Record<string, unknown>;

const mdEl = (content: string): FeishuElement => ({ tag: 'markdown', content });

/** 非 fence 段:按空行分段,**每段一个 markdown 元素** —— 飞书在单个元素内
 *  不给段落留白,元素之间才有间距;整 body 塞一个元素就是"没有排版"的
 *  真机反馈来源。引用块(`>! `/`> ` 归一)自成元素并裁剪。 */
function prose(text: string, out: FeishuElement[]): void {
  const lines = text.split('\n');
  let buf: string[] = [];
  const flush = (): void => {
    const c = buf.join('\n');
    buf = [];
    if (c.trim()) out.push(mdEl(c));
  };
  let i = 0;
  while (i < lines.length) {
    if (/^(>! |> )/.test(lines[i])) {
      flush();
      const q: string[] = [];
      while (i < lines.length && /^(>! ?|> ?)/.test(lines[i])) {
        q.push(lines[i].replace(/^(>! ?|> ?)/, ''));
        i++;
      }
      // 去首尾空行,内部空行保留(引用里的分段)。
      while (q.length && !q[0].trim()) q.shift();
      while (q.length && !q[q.length - 1].trim()) q.pop();
      const clipped = q.length > QUOTE_MAX_LINES
        ? [...q.slice(0, QUOTE_MAX_LINES), `…(+${q.length - QUOTE_MAX_LINES} more lines — open the dashboard for the full text)`]
        : q;
      if (clipped.length) out.push(mdEl(clipped.map((l) => `> ${inline(l)}`).join('\n')));
    } else if (!lines[i].trim()) {
      flush(); // 空行 = 段落边界 = 新元素
      i++;
    } else {
      buf.push(inline(lines[i]));
      i++;
    }
  }
  flush();
}

/** markdown-ish body → 飞书 card 2.0 elements。fence 独立成元素(语法高亮,
 *  内容 verbatim —— code 惰性,见文件头),空 body 也保证至少一个元素。 */
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
    out.push(mdEl(`${fence}\n${m[2].replace(/\n$/, '')}\n\`\`\``));
    last = re.lastIndex;
    if (md[last] === '\n') last++;
  }
  const rest = md.slice(last);
  if (rest.trim()) prose(rest, out);
  if (!out.length) out.push(mdEl(' '));
  return out;
}
