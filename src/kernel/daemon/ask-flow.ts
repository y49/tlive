// src/kernel/daemon/ask-flow.ts
//
// AskUserQuestion 的作答流程(per-requestId,daemon 生命周期内存态)。
//
// 一次 AskUserQuestion 调用可以带多个问题。**cursor 归 daemon 所有**,IM 和
// dashboard 都只渲染"当前这一问",通过同一组入口作答 —— 没有两套状态机可以
// 吵架,而且在手机上答一问,dashboard 会跟着推进到下一问。
//
// 四种作答方式全部收敛到两个入口:
//   pick(idx)          单选按钮
//   submit(text?)      多选 Submit / 飞书表单输入 / 引用回复的自由文本
// 都返回同一个 AskStep,调用方只管照 step 渲染或 resolve。这取代了原先
// inbound-handler(按钮 ×2、表单、引用回复)和 bootstrap(web action)里
// 五处各写一遍的"取 ctx → 拼答案 → answer()",那种重复正是漏改的温床。
//
// 整批是一个原子单元:答完最后一问才回传,中途 Skip / 超时 / 本地抢答一律
// 整批作废(本地框接管)—— 绝不提交半份答案。

import { buildAskUpdatedInput, type AskBatch } from '../permission/ask-renderer.js';

export type AskStep =
  /** 无此 requestId:卡已 stale(daemon 重启 / 已 resolve / 已被消费)。 */
  | { kind: 'stale' }
  /** 畸形下标、空提交等:不动任何状态,卡保持原样。 */
  | { kind: 'noop' }
  /** 重画卡片(推进到下一问、返回上一问,或多选勾选态变了)。 */
  | { kind: 'render'; cursor: number }
  /** 整批答完:用 updatedInput resolve,条目已自动消费。 */
  | { kind: 'answered'; updatedInput: unknown };

interface Entry {
  batch: AskBatch;
  input: unknown;
  cursor: number;
  answers: Map<number, string[]>;
  picks: Set<number>;
}

export class AskFlow {
  private byId = new Map<string, Entry>();

  begin(requestId: string, batch: AskBatch, input: unknown): void {
    this.byId.set(requestId, { batch, input, cursor: 0, answers: new Map(), picks: new Set() });
  }

  /** 只读窥视 —— 渲染用。不存在 = 卡已 stale。 */
  peek(requestId: string): { batch: AskBatch; cursor: number; picks: number[] } | undefined {
    const e = this.byId.get(requestId);
    if (!e) return undefined;
    return { batch: e.batch, cursor: e.cursor, picks: [...e.picks].sort((a, b) => a - b) };
  }

  /** 多选勾选翻转。单选问题上的 toggle 是畸形点击,不动状态。 */
  toggle(requestId: string, idx: number): AskStep {
    const e = this.byId.get(requestId);
    if (!e) return { kind: 'stale' };
    const q = e.batch.questions[e.cursor];
    if (!q.multiSelect || !q.options[idx]) return { kind: 'noop' };
    if (e.picks.has(idx)) e.picks.delete(idx);
    else e.picks.add(idx);
    return { kind: 'render', cursor: e.cursor };
  }

  /** 单选直选。多选问题上的 pick 是畸形点击,不动状态。 */
  pick(requestId: string, idx: number): AskStep {
    const e = this.byId.get(requestId);
    if (!e) return { kind: 'stale' };
    const q = e.batch.questions[e.cursor];
    if (q.multiSelect || !q.options[idx]) return { kind: 'noop' };
    return this.record(requestId, e, [q.options[idx].label]);
  }

  /** 提交当前这一问:已勾选的项 + 可选的自由文本合并成一个答案。
   *  两者皆空 = 无操作(不允许空答案)。单选问题上只有文本时,文本即答案 ——
   *  本地对话框 "Type something" 的远程孪生。 */
  submit(requestId: string, text?: string): AskStep {
    const e = this.byId.get(requestId);
    if (!e) return { kind: 'stale' };
    const q = e.batch.questions[e.cursor];
    const typed = text?.trim();
    const labels = [
      ...[...e.picks].sort((a, b) => a - b).map((i) => q.options[i].label),
      ...(typed ? [typed] : []),
    ];
    if (!labels.length) return { kind: 'noop' };
    return this.record(requestId, e, labels);
  }

  /** 退回上一问,并丢掉那一问的答案 —— 它会被重新问一遍。多问题批次里单选
   *  点一下就前进,没有这个就救不了误点。第一问上是无操作。 */
  back(requestId: string): AskStep {
    const e = this.byId.get(requestId);
    if (!e) return { kind: 'stale' };
    if (e.cursor === 0) return { kind: 'noop' };
    e.picks.clear();
    e.cursor -= 1;
    e.answers.delete(e.cursor);
    return { kind: 'render', cursor: e.cursor };
  }

  /** 释放条目(Skip / resolved / 超时 / 本地抢答)。未知 id 安全。 */
  end(requestId: string): void {
    this.byId.delete(requestId);
  }

  /** 记录当前这一问的答案并推进。答完最后一问就地消费条目 —— 消费与出答案
   *  同一步完成,所以重复点击必然拿到 stale,不可能答两次。 */
  private record(requestId: string, e: Entry, labels: string[]): AskStep {
    e.answers.set(e.cursor, labels);
    e.picks.clear();
    e.cursor += 1;
    if (e.cursor < e.batch.questions.length) return { kind: 'render', cursor: e.cursor };
    this.byId.delete(requestId);
    return { kind: 'answered', updatedInput: buildAskUpdatedInput(e.input, e.batch, e.answers) };
  }
}
