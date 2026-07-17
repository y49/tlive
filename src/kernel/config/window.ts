// src/kernel/config/window.ts
//
// 远程审批窗口的单一真相。shim(cli)、Codex companion、daemon bootstrap 三方
// 共用 —— 放在 config 层是因为它是两边共同的叶子依赖(cli 与 daemon 都已
// import config/loader),不会造成 daemon→cli 的依赖倒挂。

/** 远程审批窗口(秒)+ 对应 shim IPC 死线(毫秒)。
 *  clamp 上限 86200 对齐插件 hooks.json 的 vendor timeout(claude 86400),
 *  保证 vendor 超时永远在 shim IPC 之后才触发:窗口 < ipc(+100s) < vendor。
 *  默认 24h:**超时 ≠ 拒绝** —— 本地对话框仍在等你,超时只是远程通道断,
 *  于是你被迫回电脑,而"不必回电脑"正是 tlive 的全部价值。短窗口无真实收益
 *  (安全性是假的:30min 与 24h 对"手机丢了"无区别;新鲜度用时间做代理是错的)。
 *  Codex 侧本就无 vendor 上限却也一直跑 24h —— 零约束下的自然选择。 */
export function approvalWindow(
  approvals?: { windowSec?: number },
): { timeoutSec: number; ipcMs: number } {
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
  const timeoutSec = clamp(approvals?.windowSec ?? 86_200, 60, 86_200);
  return { timeoutSec, ipcMs: (timeoutSec + 100) * 1000 };
}
