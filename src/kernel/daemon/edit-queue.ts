// src/kernel/daemon/edit-queue.ts
//
// AskUserQuestion 卡片的 edit() 是真实网络调用:toggle(每次点击都 edit 刷新
// 复选框)与结算(onResolved 最终把卡改写为 "Answered"/"Denied"/… 并摘掉按钮)
// 两条路径都会对同一张卡发起 edit —— 网络延迟不保证"后发起的 edit 后落地"。
//
// Review Important 复现的竞态:用户快点 toggle 再点 Submit,toggle 的 edit
// 先发出、网络慢;onResolved 的结算 edit 后发出、网络快,先落地把卡改成
// "Answered"；随后 toggle 的 edit 才落地,把卡打回可点的复选框布局 ——
// "no zombie cards" 不变量被破,虽然按钮再点是 no-op(底层状态早清空,功能
// 无害),但对用户是纯 UI 层面的误导。
//
// 修法:per-requestId 的串行队列。同一 rid 上的所有 edit 严格按"入队顺序"
// (调用 enqueue 的顺序,不是网络返回顺序)一个接一个跑;于是总是最后入队的
// onResolved 结算 edit 必然是最后落地的那个。

export interface EditQueue {
  /** 把 fn 排到 rid 队列尾部,等前一个(如果有)完成后再跑。返回的 Promise 在
   *  *这一个* fn 跑完后 resolve —— 不管 fn 是否抛错(容错同旧代码到处写的
   *  `.catch(() => undefined)`:失败不断链,后面排队的 edit 照常执行)。 */
  enqueue(rid: string, fn: () => Promise<unknown>): Promise<void>;
  /** 诊断/测试用:rid 上是否还有排队中或正在跑的 edit。队列耗尽后自动清理,
   *  这里应变回 false —— 不然就是泄漏(Map 条目永久占用)。 */
  isActive(rid: string): boolean;
}

export function createEditQueue(): EditQueue {
  const queues = new Map<string, Promise<void>>();

  function enqueue(rid: string, fn: () => Promise<unknown>): Promise<void> {
    const prev = queues.get(rid) ?? Promise.resolve();
    // fn 本身吞掉自己的错误(转成 resolved undefined)——链条上没有会传播的
    // rejection,`.then(settle, settle)` 的第二个 handler 只是双保险,防御性
    // 地兜住理论上不该发生的"prev 被拒绝"。
    const settle = (): Promise<void> => fn().then(() => undefined, () => undefined);
    const next = prev.then(settle, settle);
    queues.set(rid, next);
    // 清理:只有自己仍是链尾(没有更新的 edit 排在自己后面)才删除 map 条目 ——
    // 否则会把仍在排队、尚未跑完的更新链条从 map 里摘掉,下一次 enqueue 就会
    // 误判"队列是空的"重新起头,丢失与它之前那些 edit 的顺序保证。
    void next.then(() => {
      if (queues.get(rid) === next) queues.delete(rid);
    });
    return next;
  }

  function isActive(rid: string): boolean {
    return queues.has(rid);
  }

  return { enqueue, isActive };
}
