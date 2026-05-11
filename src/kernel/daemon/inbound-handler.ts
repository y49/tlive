// src/kernel/daemon/inbound-handler.ts
//
// Receives an IncomingEnvelope and decides:
//  - drop (unauthorized)
//  - reply with 'unbound' help (chat not bound)
//  - run IM command (parseImCommand)
//  - forward as user message to active session

import type { IncomingEnvelope, IMAdapter, OutgoingMessage } from '../contracts/im-adapter.js';
import type { ChatRouter } from '../workspace/chat-router.js';
import type { SessionManager } from '../session/manager.js';
import type { WorkspaceRegistry } from '../workspace/registry.js';
import { parseImCommand, type ImCommand } from './im-commands.js';

export interface InboundHandlerDeps {
  router: ChatRouter;
  sessions: SessionManager;
  workspaces: WorkspaceRegistry;
  imBy: (channel: 'telegram' | 'feishu') => IMAdapter | undefined;
  /** active session per chat — daemon-internal state */
  activeSessionForChat: Map<string, string>; // "channel:chatId" → tliveSessionId
  /** default provider when /new */
  defaultProvider: 'claude' | 'codex';
}

const chatKey = (env: { channel: string; chatId: string }) => `${env.channel}:${env.chatId}`;

export class InboundHandler {
  constructor(private deps: InboundHandlerDeps) {}

  async handle(env: IncomingEnvelope): Promise<void> {
    // Step 1: route
    const routed = this.deps.router.route(env);
    if (routed.kind === 'drop') return; // log + silent
    if (routed.kind === 'unbound') {
      const list = this.deps.workspaces.list().map((w) => w.id).join(' / ');
      await this.reply(env, { kind: 'text', text: `Chat 未绑定 workspace。可选: ${list || '(none — 先 tlive workspace add)'}。回复 \`/use <ws>\` 绑定。` });
      return;
    }
    const wsId = routed.workspaceId;

    // Step 2: command?
    const cmd = parseImCommand(env.text);
    if (cmd) {
      await this.runCommand(env, wsId, cmd);
      return;
    }

    // Step 3: forward to active session
    const ck = chatKey(env);
    let activeId = this.deps.activeSessionForChat.get(ck);
    if (!activeId) {
      // implicit /new on first message
      const ws = this.deps.workspaces.list().find((w) => w.id === wsId);
      if (!ws) { await this.reply(env, { kind: 'text', text: 'workspace not found' }); return; }
      const sess = await this.deps.sessions.create({ workspaceDir: ws.path, provider: this.deps.defaultProvider });
      activeId = sess.tliveSessionId;
      this.deps.activeSessionForChat.set(ck, activeId);
      await this.reply(env, { kind: 'text', text: `▶ new session: ${activeId.slice(0, 8)} (provider=${this.deps.defaultProvider})` });
    }
    const rec = this.deps.sessions.get(activeId);
    if (!rec) {
      await this.reply(env, { kind: 'text', text: 'session disappeared' });
      this.deps.activeSessionForChat.delete(ck);
      return;
    }
    await rec.runtime.sendUser(env.text);
  }

  private async runCommand(env: IncomingEnvelope, wsId: string, cmd: ImCommand): Promise<void> {
    const ck = chatKey(env);
    switch (cmd.kind) {
      case 'use': {
        this.deps.router.bind(env.channel, env.chatId, cmd.workspaceId);
        // also clear active session for this chat (new ws, new session)
        this.deps.activeSessionForChat.delete(ck);
        await this.reply(env, { kind: 'text', text: `✅ chat → ${cmd.workspaceId}` });
        return;
      }
      case 'new': {
        const ws = this.deps.workspaces.list().find((w) => w.id === wsId);
        if (!ws) return;
        const sess = await this.deps.sessions.create({ workspaceDir: ws.path, provider: this.deps.defaultProvider });
        this.deps.activeSessionForChat.set(ck, sess.tliveSessionId);
        await this.reply(env, { kind: 'text', text: `▶ new session: ${sess.tliveSessionId.slice(0, 8)}` });
        return;
      }
      case 'sessions': {
        const all = this.deps.sessions.listActive().filter((s) => s.workspaceDir === this.deps.workspaces.list().find((w) => w.id === wsId)?.path);
        const lines = all.map((s) => `${s.tliveSessionId.slice(0, 8)} · ${s.provider} · ${s.providerSessionId.slice(0, 8)}`).join('\n') || '(none active)';
        await this.reply(env, { kind: 'text', text: lines });
        return;
      }
      case 'resume': {
        const rec = await this.deps.sessions.resume(cmd.sessionId);
        if (!rec) { await this.reply(env, { kind: 'text', text: 'not found' }); return; }
        this.deps.activeSessionForChat.set(ck, rec.tliveSessionId);
        await this.reply(env, { kind: 'text', text: `▶ resumed: ${rec.tliveSessionId.slice(0, 8)}` });
        return;
      }
      case 'handback': {
        const activeId = this.deps.activeSessionForChat.get(ck);
        if (!activeId) { await this.reply(env, { kind: 'text', text: 'no active session' }); return; }
        const rec = this.deps.sessions.get(activeId);
        if (!rec) return;
        await this.deps.sessions.stop(activeId);
        this.deps.activeSessionForChat.delete(ck);
        const cmdPaste = rec.provider === 'claude'
          ? `claude --resume ${rec.providerSessionId}`
          : `codex resume ${rec.providerSessionId}`;
        await this.reply(env, { kind: 'text', text: `↩ session 已释放\n粘贴到终端继续: \`${cmdPaste}\`` });
        return;
      }
      case 'stop': {
        const activeId = this.deps.activeSessionForChat.get(ck);
        if (!activeId) return;
        await this.deps.sessions.get(activeId)?.runtime.interrupt();
        await this.reply(env, { kind: 'text', text: '⏸ interrupted' });
        return;
      }
      case 'kill': {
        const activeId = this.deps.activeSessionForChat.get(ck);
        if (!activeId) return;
        await this.deps.sessions.stop(activeId);
        this.deps.activeSessionForChat.delete(ck);
        await this.reply(env, { kind: 'text', text: '⏹ killed' });
        return;
      }
      case 'help': {
        await this.reply(env, { kind: 'text', text: '/use /new /sessions /resume <id> /handback /stop /kill /model <n> /runtime claude|codex /perm on|off /help' });
        return;
      }
      case 'model':
      case 'runtime':
      case 'perm':
      case 'unknown':
        await this.reply(env, { kind: 'text', text: `command \`${cmd.kind}\` recorded (full impl pending)` });
        return;
    }
  }

  private async reply(env: IncomingEnvelope, msg: OutgoingMessage): Promise<void> {
    const a = this.deps.imBy(env.channel);
    if (!a) return;
    await a.send(msg);
  }
}
