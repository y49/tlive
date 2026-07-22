// src/kernel/permission/ask-renderer.ts
//
// AskUserQuestion(CC 专属 —— Codex 无此概念)的卡渲染 + 答案回传措辞。
//
// 机制(真机实测 claude 2.1.210):CC 为 AskUserQuestion fire PermissionRequest;
// 回 decision.behavior='deny' + message 会让 CC 跳过内置问题框,并把 message
// 送进 agent 的对话流。hook 挂起期间本地框并行弹出,先答先得 —— 本地答会
// 触发 PostToolUse,cancel 机制照常撤卡,tlive 绝不篡改键盘前的选择。
//
// agent 看到的是 "Error: <message>",所以 message 必须自证是答案而非故障:
// 来源说明 + Selected + 一份合成的 AskUserQuestionOutput JSON(继承 v1.0
// 的做法)。措辞是这套机制唯一的软肋 —— 措辞差 agent 就会重问一遍。

export interface AskOption { label: string; description?: string }
export interface AskCard { title: string; body: string; question: string; header?: string; options: AskOption[]; multiSelect: boolean }

interface RawAsk {
  questions?: Array<{
    question?: string;
    header?: string;
    options?: Array<{ label?: string; description?: string }>;
    multiSelect?: boolean;
  }>;
}

/** 归一 tool_input → 卡。malformed → null(放行让 CC 自己报错,不自作聪明)。
 *  只渲染 questions[0]:多问题批次罕见,flatten 掉。 */
export function renderAskCard(input: unknown): AskCard | null {
  const q = (input as RawAsk)?.questions?.[0];
  if (!q?.question || !Array.isArray(q.options) || q.options.length < 2) return null;
  const options: AskOption[] = q.options
    .filter((o): o is { label: string; description?: string } => typeof o?.label === 'string')
    .map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) }));
  if (options.length < 2) return null;

  const header = q.header ? `*${q.header}*\n\n` : '';
  const multiSelect = Boolean(q.multiSelect);
  // The option buttons already carry the labels, so the in-body list is pure
  // duplication UNLESS an option has a description worth showing. List only
  // when at least one description exists; otherwise the body is just the
  // question (buttons speak for themselves).
  const hasDesc = options.some((o) => o.description);
  const lines = options.map((o, i) => `**${i + 1}.** ${o.label}${o.description ? ` — ${o.description}` : ''}`);
  const body = hasDesc ? `${header}${q.question}\n\n${lines.join('\n')}` : `${header}${q.question}`;
  // No free-text hint here: channels advertise their own path (Feishu has an
  // on-card input box; Telegram appends its quote-reply hint in the adapter).
  return {
    title: 'Question',
    body,
    question: q.question,
    ...(q.header ? { header: q.header } : {}),
    options,
    multiSelect,
  };
}

/** 多选卡按钮:每个选项一个 checkbox toggle + Submit(N) 计数 + Skip。每次
 *  toggle 都要用最新 selected 重算一遍,调用方拿去 edit 卡片(Task 10)。
 *  ▣/▢(U+25A3/U+25A2,Geometric Shapes)——几何字符,不带 emoji presentation,
 *  不会被 Telegram 渲染成彩色方块;项目 emoji 白名单仅剩 ⚠️,这两个不算违规。 */
export function askMultiButtons(requestId: string, options: AskOption[], selected: number[]): Array<{ id: string; label: string }> {
  return [
    ...options.map((o, i) => ({
      id: `asktoggle:${requestId}:${i}`,
      label: `${selected.includes(i) ? '▣' : '▢'} ${o.label}`,
    })),
    { id: `asksubmit:${requestId}`, label: `Submit (${selected.length})` },
    { id: `askskip:${requestId}`, label: 'Skip' },
  ];
}

/** ANSWER an AskUserQuestion the documented + native way: behavior:"allow" with
 *  updatedInput. Mined from the installed 2.1.216 binary — CC's own submit path
 *  (`oei`) returns `{behavior:"allow", updatedInput:{...input, answers}}`, then
 *  the tool runs "without prompting" and CC emits its OWN clean feedback
 *  (`The user answered: "q"="a". …`). This replaces the old deny+message hack,
 *  which CC wrapped in an `Error: … Denied by PermissionRequest hook` shell
 *  (user-reported). `answers` maps question text → answer string (multi-select
 *  comma-separated). Only questions[0] is handled (renderAskCard flattens the
 *  batch), so the questions array is reconstructed from the card context. */
export function buildAskUpdatedInput(
  ctx: { question: string; header?: string; options: AskOption[]; multiSelect?: boolean },
  selected: string[],
): { questions: unknown[]; answers: Record<string, string> } {
  return {
    questions: [{
      question: ctx.question,
      ...(ctx.header ? { header: ctx.header } : {}),
      options: ctx.options,
      multiSelect: Boolean(ctx.multiSelect),
    }],
    answers: { [ctx.question]: selected.join(', ') },
  };
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
