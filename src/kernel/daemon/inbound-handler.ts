// src/kernel/daemon/inbound-handler.ts
//
// v2.1: SenderGuard 鉴权 + 审批按钮回调 + /perm 静音 + 续跑自由文本。无 workspace/绑定。

import type { IncomingEnvelope, IMAdapter, OutgoingMessage } from '../contracts/im-adapter.js';
import type { PermissionRouter } from './permission-router.js';
import type { ContinueBroker } from '../permission/continue-broker.js';
import type { SenderGuard } from './sender-guard.js';
import { parseImCommand } from './im-commands.js';

export interface InboundHandlerDeps {
  senderGuard: SenderGuard;
  imBy: (channel: 'telegram' | 'feishu') => IMAdapter | undefined;
  permissionRouter: PermissionRouter;
  continueBroker: ContinueBroker;
  /** Returns + clears the most-recent pending continue requestId (single-chat). */
  takeLatestContinueId: () => string | null;
  /** Toggle global notification mute (`/perm on|off`). */
  setMuted: (muted: boolean) => void;
}

function parseCallback(text: string): { requestId: string; approved: boolean } | null {
  if (text.startsWith('approve:')) return { requestId: text.slice('approve:'.length), approved: true };
  if (text.startsWith('deny:')) return { requestId: text.slice('deny:'.length), approved: false };
  return null;
}

export class InboundHandler {
  constructor(private deps: InboundHandlerDeps) {}

  async handle(env: IncomingEnvelope): Promise<void> {
    if (!this.deps.senderGuard.allows(env.channel, env.userId)) return;

    const cb = parseCallback(env.text);
    if (cb) {
      this.deps.permissionRouter.answer(cb.requestId, cb.approved);
      return;
    }

    const cmd = parseImCommand(env.text);
    if (cmd) {
      await this.runCommand(env, cmd);
      return;
    }

    const continueId = this.deps.takeLatestContinueId();
    if (continueId) {
      const hit = this.deps.continueBroker.answer(continueId, env.text);
      if (hit) return;
    }

    await this.reply(env, {
      kind: 'text',
      text: 'tlive: 只接受 /perm, /help 和审批按钮回调。自由文本可用于响应「续跑」提示。',
    });
  }

  private async runCommand(env: IncomingEnvelope, cmd: NonNullable<ReturnType<typeof parseImCommand>>): Promise<void> {
    switch (cmd.kind) {
      case 'perm':
        this.deps.setMuted(!cmd.enabled); // /perm on ⇒ 通知开 ⇒ 不静音
        await this.reply(env, { kind: 'text', text: `通知已${cmd.enabled ? '开启' : '静音'}` });
        return;
      case 'help':
        await this.reply(env, { kind: 'text', text: '/perm on|off — 开启/静音通知\n/help — 本帮助' });
        return;
      case 'unknown':
      default:
        await this.reply(env, { kind: 'text', text: '未知命令,试 /help。' });
    }
  }

  private async reply(env: IncomingEnvelope, msg: OutgoingMessage): Promise<void> {
    const a = this.deps.imBy(env.channel);
    if (!a) return;
    await a.send(msg);
  }
}
