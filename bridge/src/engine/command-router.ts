import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import type { SessionStateManager } from './session-state.js';
import type { ChannelRouter } from './router.js';
import type { QueryControls } from '../providers/base.js';
import type { VerboseLevel } from './session-state.js';
import { getBridgeContext } from '../context.js';
import { ClaudeSDKProvider } from '../providers/claude-sdk.js';
import { checkCodexAvailable } from '../providers/index.js';
import type { ClaudeSettingSource } from '../config.js';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export class CommandRouter {
  constructor(
    private state: SessionStateManager,
    private getAdapters: () => Map<string, BaseChannelAdapter>,
    private router: ChannelRouter,
    private coreAvailable: () => boolean,
    private activeControls: Map<string, QueryControls>,
    private permissions: { clearSessionWhitelist(): void },
    private onNewSession?: (channelType: string, chatId: string) => void,
  ) {}

  async handle(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const parts = msg.text.split(' ');
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '/status': {
        const ctx = getBridgeContext();
        const healthy = (ctx.core as { isHealthy?: () => boolean }).isHealthy?.() ?? false;
        const coreStatus = healthy ? '🟢 connected' : '🔴 disconnected';
        const channelList = Array.from(this.getAdapters().keys()).join(', ') || 'none';

        if (adapter.channelType === 'telegram') {
          const html = [
            `📡 <b>TLive Status</b>`,
            '',
            `<b>Bridge:</b>    🟢 running`,
            `<b>Core:</b>      ${coreStatus}`,
            `<b>Channels:</b>  <code>${channelList}</code>`,
          ].join('\n');
          await adapter.send({ chatId: msg.chatId, html });
        } else if (adapter.channelType === 'discord') {
          await adapter.send({
            chatId: msg.chatId,
            embed: {
              title: '📡 TLive Status',
              color: 0x3399FF,
              fields: [
                { name: 'Bridge', value: '🟢 Running', inline: true },
                { name: 'Core', value: coreStatus, inline: true },
                { name: 'Channels', value: `\`${channelList}\``, inline: true },
              ],
            },
          });
        } else {
          await adapter.send({
            chatId: msg.chatId,
            text: `**Bridge:** 🟢 running\n**Core:** ${coreStatus}\n**Channels:** ${channelList}`,
            feishuHeader: { template: 'blue', title: '📡 TLive Status' },
          });
        }
        return true;
      }
      case '/new': {
        // Close any active LiveSession(s) for this chat before creating new session
        this.onNewSession?.(msg.channelType, msg.chatId);
        const newSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await this.router.rebind(msg.channelType, msg.chatId, newSessionId);
        this.state.clearLastActive(msg.channelType, msg.chatId);
        // Clear Discord thread binding so next conversation creates a fresh thread
        this.state.clearThread(msg.channelType, msg.chatId);
        this.permissions.clearSessionWhitelist();
        if (adapter.channelType === 'feishu') {
          await adapter.send({
            chatId: msg.chatId,
            text: 'Session cleared. Send a message to begin.',
            feishuHeader: { template: 'green', title: '🆕 New Session' },
          });
        } else if (adapter.channelType === 'discord') {
          await adapter.send({
            chatId: msg.chatId,
            embed: { title: '🆕 New Session', description: 'Session cleared. Send a message to begin.', color: 0x00CC66 },
          });
        } else {
          await adapter.send({ chatId: msg.chatId, html: '🆕 <b>New session started.</b> Send a message to begin.' });
        }
        return true;
      }
      case '/verbose': {
        const level = parseInt(parts[1], 10) as VerboseLevel;
        if ([0, 1].includes(level)) {
          this.state.setVerboseLevel(msg.channelType, msg.chatId, level);
          const labels = ['🤫 quiet', '📝 terminal card'];
          const text = `Verbose: ${labels[level]}`;
          if (adapter.channelType === 'discord') {
            await adapter.send({ chatId: msg.chatId, embed: { description: text, color: 0x3399FF } });
          } else {
            await adapter.send({ chatId: msg.chatId, text });
          }
        } else {
          const usage = 'Usage: `/verbose 0|1`\n0=quiet, 1=terminal card';
          if (adapter.channelType === 'discord') {
            await adapter.send({ chatId: msg.chatId, embed: { description: usage, color: 0x888888 } });
          } else {
            await adapter.send({ chatId: msg.chatId, text: usage });
          }
        }
        return true;
      }
      case '/perm': {
        const sub = parts[1]?.toLowerCase();
        if (sub === 'on' || sub === 'off') {
          this.state.setPermMode(msg.channelType, msg.chatId, sub);
          const text = sub === 'on'
            ? '🔐 Permission prompts: ON — dangerous tools will ask for confirmation'
            : '⚡ Permission prompts: OFF — all tools auto-allowed';
          if (adapter.channelType === 'discord') {
            await adapter.send({ chatId: msg.chatId, embed: { description: text, color: sub === 'on' ? 0xFFA500 : 0x00CC00 } });
          } else {
            await adapter.send({ chatId: msg.chatId, text });
          }
        } else {
          const current = this.state.getPermMode(msg.channelType, msg.chatId);
          const text = `🔐 Permission mode: **${current}**\nUsage: \`/perm on|off\`\non = prompt for dangerous tools (default)\noff = auto-allow all`;
          if (adapter.channelType === 'discord') {
            await adapter.send({ chatId: msg.chatId, embed: { description: text, color: 0x888888 } });
          } else {
            await adapter.send({ chatId: msg.chatId, text });
          }
        }
        return true;
      }
      case '/stop': {
        const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
        const ctrl = this.activeControls.get(chatKey);
        if (ctrl) {
          this.activeControls.delete(chatKey);
          await ctrl.interrupt();
          await adapter.send({ chatId: msg.chatId, text: '⏹ Interrupted current execution' });
        } else {
          await adapter.send({ chatId: msg.chatId, text: '⚠️ No active execution to stop' });
        }
        return true;
      }
      case '/effort': {
        const LEVELS = ['low', 'medium', 'high', 'max'] as const;
        const level = parts[1]?.toLowerCase();
        if (level && LEVELS.includes(level as typeof LEVELS[number])) {
          this.state.setEffort(msg.channelType, msg.chatId, level as typeof LEVELS[number]);
          const icons: Record<string, string> = { low: '⚡', medium: '🧠', high: '💪', max: '🔥' };
          const text = `${icons[level] || '🧠'} Effort: **${level}**`;
          await adapter.send({ chatId: msg.chatId, text });
        } else {
          const current = this.state.getEffort(msg.channelType, msg.chatId) || 'default';
          const text = `🧠 Effort: **${current}**\nUsage: \`/effort low|medium|high|max\`\nlow = fast · medium = balanced · high = thorough · max = maximum`;
          await adapter.send({ chatId: msg.chatId, text });
        }
        return true;
      }
      case '/hooks': {
        const pauseFile = join(homedir(), '.tlive', 'hooks-paused');
        const sub = parts[1]?.toLowerCase();
        if (sub === 'pause') {
          mkdirSync(dirname(pauseFile), { recursive: true });
          writeFileSync(pauseFile, '');
          await adapter.send({ chatId: msg.chatId, text: '⏸ Hooks paused — auto-allow, no notifications.' });
        } else if (sub === 'resume') {
          try { unlinkSync(pauseFile); } catch {}
          await adapter.send({ chatId: msg.chatId, text: '▶ Hooks resumed — forwarding to IM.' });
        } else {
          const paused = existsSync(pauseFile);
          await adapter.send({ chatId: msg.chatId, text: `Hooks: ${paused ? '⏸ paused' : '▶ active'}` });
        }
        return true;
      }
      case '/sessions': {
        const { store } = getBridgeContext();
        const allSessions = await store.listSessions();
        const binding = await this.router.resolve(msg.channelType, msg.chatId);
        const currentSessionId = binding?.sessionId;

        if (allSessions.length === 0) {
          await adapter.send({ chatId: msg.chatId, text: 'No sessions found.' });
          return true;
        }

        const sorted = allSessions
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 10);

        const lines: string[] = [];
        for (let i = 0; i < sorted.length; i++) {
          const s = sorted[i];
          const isCurrent = s.id === currentSessionId;
          const marker = isCurrent ? ' ◀' : '';
          const date = new Date(s.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          const msgs = await store.getMessages(s.id);
          const firstUser = msgs.find(m => m.role === 'user');
          const preview = firstUser
            ? (firstUser.content.length > 40 ? firstUser.content.slice(0, 37) + '...' : firstUser.content)
            : '(empty)';
          lines.push(`${i + 1}. ${date} — ${preview}${marker}`);
        }

        const footer = '\nUse /session <n> to switch';

        if (adapter.channelType === 'telegram') {
          await adapter.send({ chatId: msg.chatId, html: `<b>📋 Sessions</b>\n\n${lines.join('\n')}${footer}` });
        } else if (adapter.channelType === 'discord') {
          await adapter.send({
            chatId: msg.chatId,
            embed: {
              title: '📋 Sessions',
              color: 0x3399FF,
              description: lines.join('\n') + footer,
            },
          });
        } else {
          await adapter.send({
            chatId: msg.chatId,
            text: `${lines.join('\n')}${footer}`,
            feishuHeader: { template: 'blue', title: '📋 Sessions' },
          });
        }
        return true;
      }
      case '/session': {
        const idx = parseInt(parts[1], 10);
        if (isNaN(idx) || idx < 1) {
          await adapter.send({ chatId: msg.chatId, text: 'Usage: /session <number>\nUse /sessions to list.' });
          return true;
        }

        const { store } = getBridgeContext();
        const allSessions = await store.listSessions();
        const sorted = allSessions
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 10);

        if (idx > sorted.length) {
          await adapter.send({ chatId: msg.chatId, text: `Session ${idx} not found. Use /sessions to list.` });
          return true;
        }

        const target = sorted[idx - 1];
        await this.router.rebind(msg.channelType, msg.chatId, target.id);
        this.state.clearLastActive(msg.channelType, msg.chatId);

        const msgs = await store.getMessages(target.id);
        const firstUser = msgs.find(m => m.role === 'user');
        const preview = firstUser
          ? (firstUser.content.length > 50 ? firstUser.content.slice(0, 47) + '...' : firstUser.content)
          : '(empty)';
        const hasContext = target.sdkSessionId ? '✅ has context' : '⚠️ no SDK session';
        await adapter.send({
          chatId: msg.chatId,
          text: `🔄 Switched to session ${idx}\n${preview}\n${hasContext}`,
        });
        return true;
      }
      case '/runtime': {
        const runtime = parts[1]?.toLowerCase();
        const RUNTIMES = ['claude', 'codex'] as const;
        if (runtime && RUNTIMES.includes(runtime as any)) {
          // Pre-check: reject if Codex SDK not installed
          if (runtime === 'codex' && !await checkCodexAvailable()) {
            await adapter.send({
              chatId: msg.chatId,
              text: '❌ Codex SDK not installed.\nRun: `npm install @openai/codex-sdk` in the bridge directory.',
            });
            return true;
          }
          const prevRuntime = this.state.getRuntime(msg.channelType, msg.chatId) || 'claude';
          this.state.setRuntime(msg.channelType, msg.chatId, runtime as 'claude' | 'codex');
          // Switching provider → old session ID is invalid for the new provider
          if (prevRuntime !== runtime) {
            const newSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            await this.router.rebind(msg.channelType, msg.chatId, newSessionId);
            this.state.clearLastActive(msg.channelType, msg.chatId);
          }
          const icons: Record<string, string> = { claude: '🟣', codex: '🟢' };
          const text = `${icons[runtime] || '🔄'} Runtime: **${runtime}**`;
          await adapter.send({ chatId: msg.chatId, text });
        } else {
          const current = this.state.getRuntime(msg.channelType, msg.chatId) || 'claude';
          const codexStatus = await checkCodexAvailable() ? '✅' : '❌ (not installed)';
          const text = `🔄 Runtime: **${current}**\nUsage: \`/runtime claude|codex\`\nclaude: ✅ · codex: ${codexStatus}`;
          await adapter.send({ chatId: msg.chatId, text });
        }
        return true;
      }
      case '/model': {
        const model = parts.slice(1).join(' ').trim();
        if (model) {
          if (model === 'reset' || model === 'default') {
            this.state.setModel(msg.channelType, msg.chatId, undefined);
            await adapter.send({ chatId: msg.chatId, text: '🤖 Model: reset to default' });
          } else {
            this.state.setModel(msg.channelType, msg.chatId, model);
            await adapter.send({ chatId: msg.chatId, text: `🤖 Model: **${model}**` });
          }
        } else {
          const current = this.state.getModel(msg.channelType, msg.chatId) || 'default';
          const text = `🤖 Model: **${current}**\nUsage: \`/model <name>\` or \`/model reset\`\nExamples: \`claude-sonnet-4-6\`, \`claude-opus-4-6\``;
          await adapter.send({ chatId: msg.chatId, text });
        }
        return true;
      }
      case '/settings': {
        const llm = getBridgeContext().llm;
        const arg = parts[1]?.toLowerCase();
        const runtime = this.state.getRuntime(msg.channelType, msg.chatId) || 'claude';

        if (runtime === 'codex' || !(llm instanceof ClaudeSDKProvider)) {
          // Codex runtime — show Codex-specific info
          const text = [
            '⚙️ **Codex Settings**',
            `  Model: \`${this.state.getModel(msg.channelType, msg.chatId) || 'default'}\``,
            `  Effort: \`${this.state.getEffort(msg.channelType, msg.chatId) || 'default'}\``,
            `  Perm: \`${this.state.getPermMode(msg.channelType, msg.chatId)}\``,
            '',
            'Use `/model`, `/effort`, `/perm` to change.',
            'Codex sandbox & network settings are set in config.',
          ].join('\n');
          await adapter.send({ chatId: msg.chatId, text });
          return true;
        }

        // Claude runtime — settings sources control
        const PRESETS: Record<string, ClaudeSettingSource[]> = {
          user: ['user'],
          full: ['user', 'project', 'local'],
          isolated: [],
        };

        if (arg && arg in PRESETS) {
          llm.setSettingSources(PRESETS[arg]);
          const labels: Record<string, string> = {
            user: '👤 user — auth & model only',
            full: '📦 full — auth, CLAUDE.md, MCP, skills',
            isolated: '🔒 isolated — no external settings',
          };
          await adapter.send({ chatId: msg.chatId, text: `⚙️ Settings: ${labels[arg]}` });
        } else {
          const current = llm.getSettingSources();
          const preset = current.length === 0 ? 'isolated'
            : current.length === 1 && current[0] === 'user' ? 'user'
            : current.includes('project') ? 'full'
            : current.join(',');
          const text = [
            `⚙️ Settings: **${preset}** (${current.join(', ') || 'none'})`,
            'Usage: `/settings user|full|isolated`',
            '  user — ~/.claude/settings.json (auth, model)',
            '  full — + CLAUDE.md, MCP servers, skills',
            '  isolated — no external settings',
          ].join('\n');
          await adapter.send({ chatId: msg.chatId, text });
        }
        return true;
      }
      case '/help': {
        if (adapter.channelType === 'telegram') {
          const html = [
            '<b>❓ TLive Commands</b>',
            '',
            '<code>/new</code> — New conversation',
            '<code>/sessions</code> — List recent sessions',
            '<code>/session &lt;n&gt;</code> — Switch to session #n',
            '<code>/verbose 0|1</code> — Detail level',
            '  0 = quiet · 1 = terminal card',
            '<code>/perm on|off</code> — Tool permission prompts',
            '<code>/effort low|high|max</code> — Thinking depth',
            '<code>/model &lt;name&gt;</code> — Switch model',
            '<code>/runtime claude|codex</code> — Switch AI provider',
            '<code>/settings user|full|isolated</code> — Claude settings scope',
            '<code>/stop</code> — Interrupt current execution',
            '<code>/hooks pause|resume</code> — Toggle IM approval',
            '<code>/status</code> — Bridge status',
            '<code>/approve &lt;code&gt;</code> — Approve pairing request',
            '<code>/pairings</code> — List pending pairings',
            '<code>/help</code> — This message',
            '',
            '<i>💬 Reply <b>allow</b>/<b>deny</b> to approve permissions</i>',
          ].join('\n');
          await adapter.send({ chatId: msg.chatId, html });
        } else if (adapter.channelType === 'discord') {
          await adapter.send({
            chatId: msg.chatId,
            embed: {
              title: '❓ TLive Commands',
              color: 0x5865F2,
              description: [
                '`/new` — New conversation',
                '`/sessions` — List recent sessions',
                '`/session <n>` — Switch to session #n',
                '`/verbose 0|1` — Detail level',
                '> 0 = quiet · 1 = terminal card',
                '`/perm on|off` — Tool permission prompts',
                '`/model <name>` — Switch model',
                '`/runtime claude|codex` — Switch AI provider',
                '`/settings user|full|isolated` — Claude settings scope',
                '`/hooks pause|resume` — Toggle IM approval',
                '`/status` — Bridge status',
                '`/approve <code>` — Approve pairing request',
                '`/pairings` — List pending pairings',
                '`/help` — This message',
                '',
                '*💬 Reply `allow`/`deny` to approve permissions*',
              ].join('\n'),
            },
          });
        } else {
          const feishuLines = [
            '/new — New conversation',
            '/sessions — List recent sessions',
            '/session <n> — Switch to session #n',
            '/verbose 0|1 — Detail level',
            '  0 = quiet · 1 = terminal card',
            '/perm on|off — Tool permission prompts',
            '/effort low|high|max — Thinking depth',
            '/model <name> — Switch model',
            '/runtime claude|codex — Switch AI provider',
            '/settings user|full|isolated — Claude settings scope',
            '/stop — Interrupt current execution',
            '/hooks pause|resume — Toggle IM approval',
            '/status — Bridge status',
            '/approve <code> — Approve pairing request',
            '/pairings — List pending pairings',
            '/help — This message',
            '',
            '💬 回复 **allow** / **deny** 审批权限',
          ];
          await adapter.send({
            chatId: msg.chatId,
            text: feishuLines.join('\n'),
            feishuHeader: { template: 'indigo', title: '❓ TLive Commands' },
          });
        }
        return true;
      }
      case '/approve': {
        const code = parts[1];
        if (!code) {
          await adapter.send({ chatId: msg.chatId, text: 'Usage: /approve <pairing_code>' });
          return true;
        }
        // Try to approve pairing on Telegram adapter
        const tgAdapter = this.getAdapters().get('telegram');
        if (tgAdapter && 'approvePairing' in tgAdapter) {
          const result = (tgAdapter as any).approvePairing(code);
          if (result) {
            await adapter.send({
              chatId: msg.chatId,
              text: `✅ Approved user ${result.username} (${result.userId})`,
            });
          } else {
            await adapter.send({ chatId: msg.chatId, text: '❌ Code not found or expired' });
          }
        } else {
          await adapter.send({ chatId: msg.chatId, text: '⚠️ Pairing not available' });
        }
        return true;
      }
      case '/pairings': {
        const tgAdapter = this.getAdapters().get('telegram');
        if (tgAdapter && 'listPairings' in tgAdapter) {
          const pairings = (tgAdapter as any).listPairings() as Array<{ code: string; userId: string; username: string }>;
          if (pairings.length === 0) {
            await adapter.send({ chatId: msg.chatId, text: 'No pending pairing requests.' });
          } else {
            const lines = pairings.map(p => `• <code>${p.code}</code> — ${p.username} (${p.userId})`);
            await adapter.send({
              chatId: msg.chatId,
              html: `<b>🔐 Pending Pairings</b>\n\n${lines.join('\n')}\n\nUse /approve <code> to approve.`,
            });
          }
        } else {
          await adapter.send({ chatId: msg.chatId, text: '⚠️ Pairing not available' });
        }
        return true;
      }
      default:
        return false;
    }
  }
}
