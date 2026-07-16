// src/kernel/daemon/ask-state.ts
//
// AskUserQuestion 多选卡的选中态(per-requestId,daemon 生命周期内存态)。
// 单选不经过这里 —— 点一下就是答案。

export class AskSelection {
  private sel = new Map<string, Set<number>>();

  toggle(requestId: string, idx: number): void {
    const s = this.sel.get(requestId) ?? new Set<number>();
    if (s.has(idx)) s.delete(idx);
    else s.add(idx);
    this.sel.set(requestId, s);
  }

  selected(requestId: string): number[] {
    return [...(this.sel.get(requestId) ?? [])].sort((a, b) => a - b);
  }

  clear(requestId: string): void {
    this.sel.delete(requestId);
  }
}
