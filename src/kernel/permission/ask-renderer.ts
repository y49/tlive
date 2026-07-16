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
export interface AskCard { title: string; body: string; options: AskOption[]; multiSelect: boolean }

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
  return {
    title: 'Question',
    body: `${header}${q.question}\n\n${lines.join('\n')}`,
    options,
    multiSelect: Boolean(q.multiSelect),
  };
}

/** deny 的 message —— agent 读它当答案。三段式,见文件头注释。
 *  synthetic JSON 手拼(而非整体 JSON.stringify)是为了在 "key": "value" 之间
 *  留一个空格——像真实 AskUserQuestionOutput 的通常格式化,而非压缩 JSON。 */
export function buildAskAnswerMessage(question: string, selected: string[]): string {
  const answer = selected.join(', ');
  const value = selected.length > 1 ? selected : selected[0];
  const synthetic = `{${JSON.stringify(question)}: ${JSON.stringify(value)}}`;
  return (
    `User answered via tlive (remote card).\n` +
    `Selected: ${answer}\n` +
    `Synthetic AskUserQuestionOutput: ${synthetic}\n` +
    `This is the user's final answer — proceed with it and do NOT call AskUserQuestion again.`
  );
}
