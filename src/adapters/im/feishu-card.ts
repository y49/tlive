// src/adapters/im/feishu-card.ts
//
// renderer 产出的 markdown-ish 文本(与 web/TG 共用)→ 飞书 card JSON 1.0
// elements。与 telegram-html.ts 同一角色:渠道方言的转换只住在 adapter 里,
// kernel 的卡片 body 保持渠道中立。
//
// Card JSON 1.0 的 markdown 元素能力(官方文档查证,2026-07;客户端版本门槛
// 见 docs 注):
//   支持:**bold** *italic* ~~strike~~ / ```fence```(V7.6+)/ 列表 / --- / 链接
//   不支持(会字面显示,2.0-only):行内 `code`、`> ` 引用、# 标题
//   折叠:collapsible_panel 容器(1.0,V7.9+)
//
// 取舍(每条都是"降级可读",绝不字面漏标记):
//   - 行内 `code`  → **bold**(1.0 无行内代码;官方文档建议的降级方向)
//   - `> ` 引用    → 去标记直出
//   - `>! ` 展开   → collapsible_panel:首行做 plain_text 预览头,全文在面板内
//   - ||spoiler||  → 去标记(飞书无 spoiler;secrets 走 mask 不走 spoiler)
//   - prose 转义 & < > 为数字实体 —— 飞书 markdown 认 <at>/<text_tag>/<link>
//     标签,agent 可控内容不得注入(与 TG escape-first 同纪律)。
//     fence 内不转义:代码块按文档 verbatim 展示(未真机验,验收项)。

const NUL = String.fromCharCode(0);

/** 数字实体转义,防 <at>/<text_tag> 注入。& 必须最先换。 */
function escapeFeishu(s: string): string {
  return s.replace(/&/g, '&#38;').replace(/</g, '&#60;').replace(/>/g, '&#62;');
}

/** 行内标记:escape 先行;`code` span 抽占位符(防 split 把成对 ** 切碎,
 *  TG 真机实锤过的坑),内容 * ~ 再转实体后以 **bold** 回填;||spoiler|| 去标记。 */
function inline(md: string): string {
  const codes: string[] = [];
  let s = escapeFeishu(md.split(NUL).join(''));
  s = s.replace(/`([^`\n]*)`/g, (_m, c: string) => {
    codes.push(c);
    return `${NUL}${codes.length - 1}${NUL}`;
  });
  s = s.replace(/\|\|([^|\n]+)\|\|/g, '$1');
  return s.replace(new RegExp(`${NUL}(\\d+)${NUL}`, 'g'), (_m, i: string) => {
    const body = codes[Number(i)].replace(/\*/g, '&#42;').replace(/~/g, '&#126;');
    return body ? `**${body}**` : '';
  });
}

/** collapsible_panel 的 plain_text 预览头:去掉行内标记后的首行。 */
function plainPreview(line: string): string {
  return line
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/\|\|([^|\n]+)\|\|/g, '$1')
    .slice(0, 80);
}

type FeishuElement = Record<string, unknown>;

const mdEl = (content: string): FeishuElement => ({ tag: 'markdown', content });

/** 非 fence 段:按行聚合 `>! `(→折叠面板)/ `> `(→去标记),其余行 inline。 */
function prose(text: string, out: FeishuElement[]): void {
  const lines = text.split('\n');
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length) { out.push(mdEl(buf.join('\n'))); buf = []; }
  };
  let i = 0;
  while (i < lines.length) {
    if (/^>! /.test(lines[i])) {
      flush();
      const q: string[] = [];
      while (i < lines.length && /^>! /.test(lines[i])) { q.push(lines[i].slice(3)); i++; }
      out.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: { title: { tag: 'plain_text', content: plainPreview(q[0]) } },
        elements: [mdEl(q.map(inline).join('\n'))],
      });
    } else if (/^> /.test(lines[i])) {
      while (i < lines.length && /^> /.test(lines[i])) { buf.push(inline(lines[i].slice(2))); i++; }
    } else {
      buf.push(inline(lines[i]));
      i++;
    }
  }
  flush();
}

/** markdown-ish body → 飞书 card 1.0 elements。空 body 也保证至少一个元素
 *  (零元素卡片可能被 API 拒收 —— 文档未明说,保守起见;真机验收项)。 */
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
