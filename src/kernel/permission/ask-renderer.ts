// src/kernel/permission/ask-renderer.ts
//
// AskUserQuestion(CC 专属 —— Codex 无此概念)的卡渲染 + 答案回传措辞。
//
// 机制(真机实测 claude 2.1.210):CC 为 AskUserQuestion fire PermissionRequest;
// 挂起期间本地框并行弹出,先答先得 —— 本地答会触发 PostToolUse,cancel 机制
// 照常撤卡,tlive 绝不篡改键盘前的选择。
//
// **一次调用可以带多个问题**(CC 的问题框把它们渲染成 tab)。整批被当作一个
// 单元:要么全部答完再回传,要么一个都不答(Skip / 超时 → 本地框接管)。
// 早期版本只渲染 questions[0] 并重建一个单问题的 updatedInput —— 结果是从
// IM 或 dashboard 答一个三问批次时,第 2、3 问被静默丢弃,agent 根本不知道
// 自己问过。答案回传因此改为**摊开原始 input**(见 buildAskUpdatedInput):
// 不重建 = 结构上不可能漏。

export interface AskOption { label: string; description?: string }
export interface AskQuestion { question: string; header?: string; options: AskOption[]; multiSelect: boolean }
export interface AskBatch { questions: AskQuestion[] }

interface RawAsk {
  questions?: Array<{
    question?: string;
    header?: string;
    options?: Array<{ label?: string; description?: string }>;
    multiSelect?: boolean;
  }>;
}

function parseQuestion(raw: NonNullable<RawAsk['questions']>[number]): AskQuestion | null {
  if (!raw?.question || !Array.isArray(raw.options)) return null;
  const options: AskOption[] = raw.options
    .filter((o): o is { label: string; description?: string } => typeof o?.label === 'string')
    .map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) }));
  if (options.length < 2) return null;
  return {
    question: raw.question,
    ...(raw.header ? { header: raw.header } : {}),
    options,
    multiSelect: Boolean(raw.multiSelect),
  };
}

/** 归一 tool_input → 整批问题。malformed → null(放行让 CC 自己报错,不自作聪明)。
 *  任一问题不合法就整批作废:半批接受 = 半份答案 = 静默丢问题,正是本模块要根除的。 */
export function parseAskBatch(input: unknown): AskBatch | null {
  const raw = (input as RawAsk)?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: AskQuestion[] = [];
  for (const r of raw) {
    const q = parseQuestion(r);
    if (!q) return null;
    questions.push(q);
  }
  return { questions };
}

/** 当前这一问的卡标题 + 正文。多问题批次把进度写进 title(`Question 2/3`)——
 *  IM 和 web 都渲染 title,不必碰 im-adapter 的冻结面加字段。 */
export function renderAskBody(batch: AskBatch, cursor: number): { title: string; body: string } {
  const total = batch.questions.length;
  const q = batch.questions[Math.min(Math.max(cursor, 0), total - 1)];
  const header = q.header ? `*${q.header}*\n\n` : '';
  // The option buttons already carry the labels, so the in-body list is pure
  // duplication UNLESS an option has a description worth showing.
  const hasDesc = q.options.some((o) => o.description);
  const lines = q.options.map((o, i) => `**${i + 1}.** ${o.label}${o.description ? ` — ${o.description}` : ''}`);
  return {
    title: total > 1 ? `Question ${cursor + 1}/${total}` : 'Question',
    body: hasDesc ? `${header}${q.question}\n\n${lines.join('\n')}` : `${header}${q.question}`,
  };
}

/** 当前这一问的按钮。单选 = 编号直选;多选 = checkbox + Submit(N)。
 *  ▣/▢(U+25A3/U+25A2,Geometric Shapes)—— 几何字符,不带 emoji presentation,
 *  不会被 Telegram 渲染成彩色方块;项目 emoji 白名单仅剩 ⚠️,这两个不算违规。
 *  Back 只在 cursor>0 出现 —— 多问题批次里单选点一下就前进,没有 Back 就没法
 *  救误点。Skip 恒在末位:任何时候都能把整批交回终端(绝不提交半份答案)。 */
export function askButtons(
  requestId: string,
  batch: AskBatch,
  cursor: number,
  picks: number[],
): Array<{ id: string; label: string }> {
  const q = batch.questions[cursor];
  const opts = q.multiSelect
    ? q.options.map((o, i) => ({ id: `asktoggle:${requestId}:${i}`, label: `${picks.includes(i) ? '▣' : '▢'} ${o.label}` }))
    : q.options.map((o, i) => ({ id: `ask:${requestId}:${i}`, label: `${i + 1}. ${o.label}` }));
  return [
    ...opts,
    ...(q.multiSelect ? [{ id: `asksubmit:${requestId}`, label: `Submit (${picks.length})` }] : []),
    ...(cursor > 0 ? [{ id: `askback:${requestId}`, label: '← Back' }] : []),
    { id: `askskip:${requestId}`, label: 'Skip' },
  ];
}

/** ANSWER an AskUserQuestion the documented + native way: behavior:"allow" with
 *  updatedInput. Mined from the installed 2.1.216 binary — CC's own submit path
 *  (`oei`) returns `{behavior:"allow", updatedInput:{...input, answers}}`, then
 *  the tool runs "without prompting" and CC emits its OWN clean feedback
 *  (`The user answered: "q"="a". …`).
 *
 *  原始 input 原样摊开,只补 `answers` —— **不重建 questions**。重建是旧实现
 *  丢问题的根源;摊开之后,批次里有几个问题就原样有几个,漏答只可能是 answers
 *  少一项(可检出),不可能是问题凭空消失(不可检出)。
 *  `answers` 映射 问题文本 → 答案字符串(多选逗号分隔)。 */
export function buildAskUpdatedInput(
  originalInput: unknown,
  batch: AskBatch,
  answers: ReadonlyMap<number, string[]>,
): unknown {
  const map: Record<string, string> = {};
  batch.questions.forEach((q, i) => {
    const picked = answers.get(i);
    if (picked?.length) map[q.question] = picked.join(', ');
  });
  return { ...(originalInput as Record<string, unknown>), answers: map };
}

/** The settled card must still show WHAT was answered (user feedback: after
 *  picking, "不知道当时选择的什么了"). Reads the answer back out of the ask
 *  updatedInput.answers — single source of truth with buildAskUpdatedInput. */
export function extractAskAnswer(updatedInput: unknown): string | null {
  const answers = (updatedInput as { answers?: Record<string, unknown> } | null)?.answers;
  if (!answers || typeof answers !== 'object') return null;
  const vals = Object.values(answers).filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return vals.length ? vals.join('; ') : null;
}
