// src/kernel/daemon/inbound-handler.ts
//
// v2.1: SenderGuard 鉴权 + 审批按钮回调 + /perm 静音 + 续跑自由文本。无 workspace/绑定。

import type { IncomingEnvelope, IMAdapter, OutgoingMessage } from '../contracts/im-adapter.js';
import type { PermissionRouter } from './permission-router.js';
import type { ContinueBroker } from '../permission/continue-broker.js';
import type { SenderGuard } from './sender-guard.js';
import { parseImCommand } from './im-commands.js';
import { buildAskAnswerMessage, type AskOption } from '../permission/ask-renderer.js';

export interface InboundHandlerDeps {
  senderGuard: SenderGuard;
  imBy: (channel: 'telegram' | 'feishu') => IMAdapter | undefined;
  permissionRouter: PermissionRouter;
  continueBroker: ContinueBroker;
  /** Returns + clears the most-recent pending continue requestId (single-chat). */
  takeLatestContinueId: () => string | null;
  /** Toggle global notification mute (`/perm on|off`). */
  setMuted: (muted: boolean) => void;
  /** Toggle the trust switch (auto-allow all until off). */
  setTrust: (trusted: boolean) => void;
  /** Grant "always allow <tool>" (in-memory). */
  addAllowTool: (tool: string) => void;
  /** Returns + clears the pending AskUserQuestion context for a requestId
   *  (single-use; Task 9). Populated by the permission router's onPending,
   *  consumed here on an `ask:`/`askskip:` button click. */
  takeAskContext: (requestId: string) => { question: string; options: AskOption[] } | undefined;
  /** Reply-to routing: IM messageId → session cwd (daemon-lifetime map). */
  resolveReply: (channel: string, messageId: string) => string | undefined;
  /** Session lookup for injection routing. */
  sessionInfo: (cwd: string) => { kind: 'wrapped' | 'hook'; label: string; sockPath?: string; continueId?: string } | undefined;
  /** All current sessions (for bare-text single-session routing). */
  listSessions: () => Array<{ cwd: string; kind: 'wrapped' | 'hook'; label: string; sockPath?: string }>;
  /** Inject text into a wrapped session's pty (bracketed paste + Enter). */
  inject: (sockPath: string, text: string) => Promise<void>;
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
    if (!env.text && !env.attachments?.length) return;

    if (env.text.startsWith('pause:')) {
      const requestId = env.text.slice('pause:'.length);
      this.deps.setTrust(true);
      this.deps.permissionRouter.answer(requestId, true); // approve the in-hand op too
      await this.reply(env, { kind: 'text', text: '已暂停审批:当前操作已放行,后续自动放行,发送 /trust off 恢复。' });
      return;
    }

    if (env.text.startsWith('allowtool:')) {
      // allowtool:<requestId>:<toolName> — grant "always allow" AND approve the in-hand request
      const rest = env.text.slice('allowtool:'.length);
      const sep = rest.indexOf(':');
      if (sep > 0) {
        const requestId = rest.slice(0, sep);
        const tool = rest.slice(sep + 1);
        this.deps.addAllowTool(tool);
        this.deps.permissionRouter.answer(requestId, true);
        await this.reply(env, { kind: 'text', text: `Approved. ${tool} will be auto-allowed from now on (until daemon restart; unaffected by /trust off).` });
      }
      return;
    }

    if (env.text.startsWith('ask:')) {
      // ask:<requestId>:<optionIndex> — a picked AskUserQuestion option.
      const [, rid, idxRaw] = env.text.split(':');
      const ctx = this.deps.takeAskContext(rid);
      const idx = Number(idxRaw);
      if (ctx && Number.isInteger(idx) && ctx.options[idx]) {
        // deny + message = 答案(见 ask-renderer 文件头):CC 跳过内置问题框,
        // message 送进 agent 对话流当答案。
        this.deps.permissionRouter.answer(rid, false, buildAskAnswerMessage(ctx.question, [ctx.options[idx].label]));
      }
      return;
    }
    if (env.text.startsWith('askskip:')) {
      const rid = env.text.slice('askskip:'.length);
      this.deps.takeAskContext(rid); // clear, avoid leak — the answer itself is discarded
      // Skip = allow = pass-through:本地问题框归你在电脑前答(等同 defer 语义),
      // 不是自动批准执行工具。
      this.deps.permissionRouter.answer(rid, true);
      return;
    }

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

    // Reply-to routing: quoting a tlive message targets that message's session.
    if (env.replyToMessageId) {
      await this.routeReply(env);
      return;
    }

    const continueId = env.text ? this.deps.takeLatestContinueId() : null;
    if (continueId) {
      const hit = this.deps.continueBroker.answer(continueId, env.text);
      if (hit) return;
    }

    // Bare text: with exactly ONE wrapped session, inject directly; more → ask to quote.
    const wrapped = this.deps.listSessions().filter((s) => s.kind === 'wrapped' && s.sockPath);
    if (wrapped.length === 1) {
      await this.injectTo(env, wrapped[0].sockPath!, wrapped[0].label);
      return;
    }
    if (wrapped.length > 1) {
      await this.reply(env, { kind: 'text', text: `有 ${wrapped.length} 个活跃会话,请引用(回复)对应会话的消息来指定目标。` });
      return;
    }

    await this.reply(env, {
      kind: 'text',
      text: 'tlive: 无活动会话可接收文本。引用某条会话消息可将文本发入该终端(需 tlive run 包裹);命令见 /help。',
    });
  }

  /** Quoted-message routing: live continue answer > wrapped pty injection > guidance. */
  private async routeReply(env: IncomingEnvelope): Promise<void> {
    const cwd = this.deps.resolveReply(env.channel, env.replyToMessageId!);
    if (!cwd) {
      await this.reply(env, { kind: 'text', text: '找不到该消息对应的会话(daemon 可能重启过),请引用较新的消息。' });
      return;
    }
    const s = this.deps.sessionInfo(cwd);
    if (!s) {
      await this.reply(env, { kind: 'text', text: '该会话已结束。' });
      return;
    }
    // A pending Stop-continue is the official resume path — prefer it over injection.
    // (Attachment-only messages skip this: an empty continue reply is meaningless.)
    if (s.continueId && env.text && this.deps.continueBroker.answer(s.continueId, env.text)) return;
    if (s.kind === 'wrapped' && s.sockPath) {
      await this.injectTo(env, s.sockPath, s.label);
      return;
    }
    await this.reply(env, { kind: 'text', text: `[${s.label}] 未用 tlive run 包裹,无法注入文本。审批请用按钮;续跑请在「续跑」提示后直接回复。` });
  }

  private async injectTo(env: IncomingEnvelope, sockPath: string, label: string): Promise<void> {
    // Attachments arrive as local paths (downloaded by the adapter) — hand the
    // agent the paths alongside the caption text; it reads them itself.
    const paths = (env.attachments ?? []).map((a) => a.localPath);
    const text = [env.text, ...paths].filter(Boolean).join('\n');
    if (!text) return;
    try {
      await this.deps.inject(sockPath, text);
      const n = paths.length;
      await this.reply(env, { kind: 'text', text: `Sent to [${label}]${n ? ` (${n} attachment path${n === 1 ? '' : 's'})` : ''}` });
    } catch {
      await this.reply(env, { kind: 'text', text: `[${label}] 注入失败:会话可能已退出。` });
    }
  }

  private async runCommand(env: IncomingEnvelope, cmd: NonNullable<ReturnType<typeof parseImCommand>>): Promise<void> {
    switch (cmd.kind) {
      case 'perm':
        this.deps.setMuted(!cmd.enabled); // /perm on ⇒ 通知开 ⇒ 不静音
        await this.reply(env, { kind: 'text', text: `通知已${cmd.enabled ? '开启' : '静音'}` });
        return;
      case 'trust':
        this.deps.setTrust(cmd.enabled);
        await this.reply(env, { kind: 'text', text: `审批已${cmd.enabled ? '暂停(自动放行)' : '恢复'}` });
        return;
      case 'help':
        await this.reply(env, { kind: 'text', text: '/perm on|off — 开启/静音通知\n/trust on|off — 暂停/恢复审批(自动放行)\n/help — 本帮助\n\n引用某条会话消息并回复文本 → 直接发入该终端(需 tlive run 包裹)\n单个活跃会话时,直接发文本即可' });
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
