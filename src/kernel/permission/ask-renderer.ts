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
export interface AskCard { title: string; body: string; question: string; options: AskOption[]; multiSelect: boolean }

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
  const lines = options.map((o, i) => `**${i + 1}.** ${o.label}${o.description ? ` — ${o.description}` : ''}`);
  const multiSelect = Boolean(q.multiSelect);
  // The local CC dialog always offers a free-form "Type something" escape
  // hatch — the remote card must advertise its equivalent (quote-reply) or
  // remote users think the listed options are the whole universe.
  const hint = multiSelect
    ? '*Tap to toggle, Submit to send — or reply to this card to answer in your own words (any ticked boxes are included).*'
    : '*Tap a button — or reply to this card to answer in your own words.*';
  return {
    title: 'Question',
    body: `${header}${q.question}\n\n${lines.join('\n')}\n\n${hint}`,
    question: q.question,
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

/** deny 的 message —— agent 读它当答案。措辞要点(真机反馈迭代):CC 把它包进
 *  "Error: …" 甚至 "Stop hook feedback / Denied by PermissionRequest hook" 的
 *  外壳里展示,所以第一句必须自证「没有任何故障、这就是答案」,答案本身
 *  紧跟其后 —— 旧版把来源解释放最前,agent 见 Error+解释就当故障处理。
 *  synthetic JSON 手拼(而非整体 JSON.stringify)是为了在 "key": "value" 之间
 *  留一个空格——像真实 AskUserQuestionOutput 的通常格式化,而非压缩 JSON。 */
export function buildAskAnswerMessage(question: string, selected: string[]): string {
  const answer = selected.join(', ');
  const value = selected.length > 1 ? selected : selected[0];
  const synthetic = `{${JSON.stringify(question)}: ${JSON.stringify(value)}}`;
  return (
    `Nothing failed — the user ANSWERED this question remotely (tlive card); the deny is just the transport.\n` +
    `Answer: ${answer}\n` +
    `Equivalent AskUserQuestionOutput: ${synthetic}\n` +
    `Continue the task using this answer. Do not call AskUserQuestion again for this question.`
  );
}

/** The settled card must still show WHAT was answered (user feedback: after
 *  picking, "不知道当时选择的什么了"). Extracts the Answer line back out of the
 *  deny message — single source of truth with buildAskAnswerMessage. */
export function extractAskAnswer(message: string): string | null {
  const m = /^Answer: (.*)$/m.exec(message);
  return m ? m[1] : null;
}
