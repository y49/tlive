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
//
// 多渠道复审补充:这个保证只在"入队顺序本身正确"的前提下成立。队列只按
// rid 键控(不区分 channel)是有意的、也是安全的一句话 —— 但前提是所有调用
// 方都必须在同一个事件循环 tick 内**同步**把某一批 edit 全部 enqueue 完,
// 不能在多张卡的循环里逐张 await。哪怕只有一条调用链在循环内 await,只要另
// 一条链(如 onResolved 的结算循环)恰好在这段 await 期间抢先同步入队了"更
// 快的那个 channel"的结算 edit,后者就会插到该 channel 尚未入队的 toggle
// edit 之前 —— 入队顺序本身就错了,队列再"忠实执行入队顺序"也没用。两条
// 生产者(inbound-handler.ts 的 asktoggle: 分支、bootstrap.ts 的 onResolved)
// 必须都遵守"同步批量入队,不逐张 await"这一纪律,详见各自调用点的注释。

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
    // 地兜住理论上不该发生的"prev 被拒绝"。try/catch 再兜一层:`fn` 的类型是
    // `() => Promise<unknown>`,但调用方传入的实参未必真是 async 函数 ——
    // 若 fn 在拿到 Promise 之前就同步 throw(现实中两个真实 IMAdapter.edit()
    // 都是 async 函数,不会发生),没有这层 try/catch 时 `settle()` 本身会
    // 同步抛出,链条(`next`)直接 reject,cleanup 那句 `next.then(...)` 因为
    // 没挂 onRejected 而永不触发 —— 既破坏"enqueue 永不 reject"的约定,也让
    // 该 rid 的 map 条目泄漏,还会产生一条 unhandled rejection 告警。
    const settle = (): Promise<void> => {
      try {
        return fn().then(() => undefined, () => undefined);
      } catch {
        return Promise.resolve();
      }
    };
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
