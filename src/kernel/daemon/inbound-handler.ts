// src/kernel/daemon/inbound-handler.ts
//
// M1 responsibilities (hook layer):
//  - Button callback: approve:<id> / deny:<id>  → permissionRouter.answer
//  - Free text when a continue request is pending → continueBroker.answer
//  - /use <ws>  → bind chat to workspace
//  - /perm / /help
//  - Unknown free text → help hint

import type { IncomingEnvelope, IMAdapter, OutgoingMessage } from '../contracts/im-adapter.js';
import type { ChatRouter } from '../workspace/chat-router.js';
import type { WorkspaceRegistry } from '../workspace/registry.js';
import type { PermissionRouter } from './permission-router.js';
import type { ContinueBroker } from '../permission/continue-broker.js';
import { parseImCommand } from './im-commands.js';

export interface InboundHandlerDeps {
  router: ChatRouter;
  workspaces: WorkspaceRegistry;
  imBy: (channel: 'telegram' | 'feishu') => IMAdapter | undefined;
  permissionRouter: PermissionRouter;
  continueBroker: ContinueBroker;
  /** workspaceId → latest pending continue requestId (maintained by bootstrap onRequest) */
  latestContinueId: Map<string, string>;
}

function parseCallback(text: string): { requestId: string; approved: boolean } | null {
  if (text.startsWith('approve:')) return { requestId: text.slice('approve:'.length), approved: true };
  if (text.startsWith('deny:')) return { requestId: text.slice('deny:'.length), approved: false };
  return null;
}

export class InboundHandler {
  constructor(private deps: InboundHandlerDeps) {}

  async handle(env: IncomingEnvelope): Promise<void> {
    // Button callback: approve:<id> or deny:<id> — checked BEFORE router.route() unbound
    // early-exit: requestId is global and chat binding is not required.
    const cb = parseCallback(env.text);
    if (cb) {
      this.deps.permissionRouter.answer(cb.requestId, cb.approved);
      return;
    }

    // Route
    const routed = this.deps.router.route(env);
    if (routed.kind === 'drop') return;
    if (routed.kind === 'unbound') {
      const list = this.deps.workspaces.list().map((w) => w.id).join(' / ');
      await this.reply(env, { kind: 'text', text: `Chat 未绑定 workspace。可选: ${list || '(none — 先 tlive workspace add)'}。回复 \`/use <ws>\` 绑定。` });
      return;
    }
    const wsId = routed.workspaceId;

    // IM command
    const cmd = parseImCommand(env.text);
    if (cmd) {
      await this.runCommand(env, wsId, cmd);
      return;
    }

    // Free text: if there is a pending continue request for this workspace, answer it.
    // answer() returns false when the requestId is stale (timed out) — fall through to
    // help hint in that case so the message is not silently swallowed.
    const continueId = this.deps.latestContinueId.get(wsId);
    if (continueId) {
      this.deps.latestContinueId.delete(wsId);
      const hit = this.deps.continueBroker.answer(continueId, env.text);
      if (hit) return;
    }

    // Otherwise: help hint
    await this.reply(env, {
      kind: 'text',
      text: 'tlive v2: 只接受 /use, /perm, /help 命令和按钮回调。自由文本可用于响应「续跑」提示。',
    });
  }

  private async runCommand(env: IncomingEnvelope, wsId: string, cmd: ReturnType<typeof parseImCommand>): Promise<void> {
    if (!cmd) return;
    switch (cmd.kind) {
      case 'use': {
        this.deps.router.bind(env.channel, env.chatId, cmd.workspaceId);
        this.deps.latestContinueId.delete(wsId);
        await this.reply(env, { kind: 'text', text: `✅ chat → ${cmd.workspaceId}` });
        return;
      }
      case 'perm': {
        await this.reply(env, { kind: 'text', text: `perm ${cmd.enabled ? 'on' : 'off'} (recorded)` });
        return;
      }
      case 'help': {
        await this.reply(env, {
          kind: 'text',
          text: '/use <ws> — bind chat to workspace\n/perm on|off — toggle permission filter\n/help — this message',
        });
        return;
      }
      case 'unknown':
      default:
        await this.reply(env, { kind: 'text', text: `unknown command. Try /help.` });
    }
  }

  private async reply(env: IncomingEnvelope, msg: OutgoingMessage): Promise<void> {
    const a = this.deps.imBy(env.channel);
    if (!a) return;
    await a.send(msg);
  }
}
