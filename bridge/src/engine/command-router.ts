import type { BaseChannelAdapter } from '../channels/base.js';
import type { ChannelType, InboundMessage } from '../channels/types.js';
import type { SessionStateManager } from './session-state.js';
import type { ChannelRouter } from './router.js';
import type { QueryControls } from '../providers/base.js';
import type { VerboseLevel } from './session-state.js';
import type { ControlPanel } from './control-panel.js';
import type { NotificationRenderer } from '../renderers/types.js';
import type { WorkspaceManager } from './workspace-manager.js';

import { getBridgeContext } from '../context.js';
import { ClaudeSDKProvider } from '../providers/claude-sdk.js';
import { checkCodexAvailable } from '../providers/index.js';
import { isKnownFlavor } from '../flavors.js';
import type { ClaudeSettingSource } from '../config.js';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/** Minimal interface for aborting a running session by ID. */
export interface SessionController {
  abort(sessionId: string): Promise<void> | void;
}

function formatSince(ts: number): string {
  const diffMs = Date.now() - ts;
  const min = Math.round(diffMs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export class CommandRouter {
  private controlPanel?: ControlPanel;
  private workspaceManager?: WorkspaceManager;
  private sessionController?: SessionController;

  constructor(
    private state: SessionStateManager,
    private getAdapters: () => Map<string, BaseChannelAdapter>,
    private router: ChannelRouter,
    private activeControls: Map<string, QueryControls>,
    private permissions: { clearSessionWhitelist(): void },
    private onNewSession?: (channelType: string, chatId: string) => void,
    private renderers?: Map<ChannelType, NotificationRenderer>,
  ) {}

  private static MENU_HINT = '\n\n💡 Tip: Use /menu for the new control panel';

  /** Inject ControlPanel after construction (avoids circular deps) */
  setControlPanel(panel: ControlPanel): void {
    this.controlPanel = panel;
  }

  /** Inject WorkspaceManager after construction (avoids circular deps) */
  setWorkspaceManager(mgr: WorkspaceManager): void {
    this.workspaceManager = mgr;
  }

  /** Inject SessionController after construction (avoids circular deps) */
  setSessionController(ctrl: SessionController): void {
    this.sessionController = ctrl;
  }

  async handle(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const parts = msg.text.split(' ');
    const cmd = parts[0].toLowerCase();
    const r = this.renderers!.get(adapter.channelType)!;

    switch (cmd) {
      case '/menu': {
        if (this.controlPanel) {
          await this.controlPanel.show(adapter, msg.chatId);
        } else {
          await adapter.send(msg.chatId, r.renderSimpleText('⚠️ Control panel not available'));
        }
        return true;
      }
      case '/status': {
        const channelList = Array.from(this.getAdapters().keys()).join(', ') || 'none';

        await adapter.send(msg.chatId, r.renderCommandResponse({
          title: '📡 TLive Status',
          fields: [
            { name: 'Bridge', value: '🟢 Running', inline: true },
            { name: 'Channels', value: `\`${channelList}\``, inline: true },
          ],
          color: 'info',
        }));
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
        await adapter.send(msg.chatId, r.renderCommandResponse({
          title: '🆕 New Session',
          body: 'Session cleared. Send a message to begin.',
          color: 'success',
        }));
        return true;
      }
      case '/verbose': {
        const level = parseInt(parts[1], 10) as VerboseLevel;
        if ([0, 1, 2].includes(level)) {
          // Workspace-scoped: prefer workspace preference, fall back to per-chat state
          if (this.workspaceManager) {
            const ws = this.workspaceManager.findByThread(msg.chatId);
            if (ws) {
              this.workspaceManager.update(ws.name, { verbose: level });
              this.workspaceManager.persist();
            } else {
              this.state.setVerboseLevel(msg.channelType, msg.chatId, level);
            }
          } else {
            this.state.setVerboseLevel(msg.channelType, msg.chatId, level);
          }
          const labels = ['🤫 quiet — alerts only', '📝 normal — summaries + files', '🔊 full — all events'];
          const text = `Verbose: ${labels[level]}${CommandRouter.MENU_HINT}`;
          await adapter.send(msg.chatId, r.renderSimpleText(text));
        } else {
          const usage = 'Usage: `/verbose 0|1|2`\n0=quiet (alerts only) · 1=normal (summaries+files) · 2=full (all events)';
          await adapter.send(msg.chatId, r.renderSimpleText(usage));
        }
        return true;
      }
      case '/perm': {
        const sub = parts[1]?.toLowerCase();
        const wsForPerm = this.workspaceManager?.findByThread(msg.chatId);
        if (sub === 'on' || sub === 'off') {
          if (wsForPerm) {
            this.workspaceManager!.update(wsForPerm.name, { perm: sub });
            this.workspaceManager!.persist();
          } else {
            this.state.setPermMode(msg.channelType, msg.chatId, sub);
          }
          const text = (sub === 'on'
            ? '🔐 Permission prompts: ON — dangerous tools will ask for confirmation'
            : '⚡ Permission prompts: OFF — all tools auto-allowed') + CommandRouter.MENU_HINT;
          await adapter.send(msg.chatId, r.renderSimpleText(text));
        } else {
          const current = wsForPerm?.perm ?? this.state.getPermMode(msg.channelType, msg.chatId);
          const text = `🔐 Permission mode: **${current}**\nUsage: \`/perm on|off\`\non = prompt for dangerous tools (default)\noff = auto-allow all`;
          await adapter.send(msg.chatId, r.renderSimpleText(text));
        }
        return true;
      }
      case '/stop': {
        const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
        const ctrl = this.activeControls.get(chatKey);
        let interrupted = false;
        if (ctrl) {
          this.activeControls.delete(chatKey);
          await ctrl.interrupt();
          interrupted = true;
        }

        // Workspace-aware: clear activeSessionId and persist
        if (this.workspaceManager) {
          const ws = this.workspaceManager.findByThread(msg.chatId);
          if (ws?.activeSessionId) {
            const sessionId = ws.activeSessionId;
            this.workspaceManager.update(ws.name, {
              activeSessionId: undefined,
              lastSessionId: sessionId,
            });
            if (this.sessionController) {
              await this.sessionController.abort(sessionId);
            }
            this.workspaceManager.persist();
            interrupted = true;
          }
        }

        if (interrupted) {
          await adapter.send(msg.chatId, r.renderSimpleText('⏹ Interrupted current execution' + CommandRouter.MENU_HINT));
        } else {
          await adapter.send(msg.chatId, r.renderSimpleText('⚠️ No active execution to stop'));
        }
        return true;
      }
      case '/effort': {
        const LEVELS = ['low', 'medium', 'high', 'max'] as const;
        const level = parts[1]?.toLowerCase();
        const wsForEffort = this.workspaceManager?.findByThread(msg.chatId);
        if (level && LEVELS.includes(level as typeof LEVELS[number])) {
          if (wsForEffort) {
            this.workspaceManager!.update(wsForEffort.name, { effort: level as typeof LEVELS[number] });
            this.workspaceManager!.persist();
          } else {
            this.state.setEffort(msg.channelType, msg.chatId, level as typeof LEVELS[number]);
          }
          const icons: Record<string, string> = { low: '⚡', medium: '🧠', high: '💪', max: '🔥' };
          const text = `${icons[level] || '🧠'} Effort: **${level}**${CommandRouter.MENU_HINT}`;
          await adapter.send(msg.chatId, r.renderSimpleText(text));
        } else {
          const current = wsForEffort?.effort ?? this.state.getEffort(msg.channelType, msg.chatId) ?? 'default';
          const text = `🧠 Effort: **${current}**\nUsage: \`/effort low|medium|high|max\`\nlow = fast · medium = balanced · high = thorough · max = maximum`;
          await adapter.send(msg.chatId, r.renderSimpleText(text));
        }
        return true;
      }
      case '/hooks': {
        const pauseFile = join(homedir(), '.tlive', 'hooks-paused');
        const sub = parts[1]?.toLowerCase();
        if (sub === 'pause') {
          mkdirSync(dirname(pauseFile), { recursive: true });
          writeFileSync(pauseFile, '');
          await adapter.send(msg.chatId, r.renderSimpleText('⏸ Hooks paused — auto-allow, no notifications.'));
        } else if (sub === 'resume') {
          try { unlinkSync(pauseFile); } catch {}
          await adapter.send(msg.chatId, r.renderSimpleText('▶ Hooks resumed — forwarding to IM.'));
        } else {
          const paused = existsSync(pauseFile);
          await adapter.send(msg.chatId, r.renderSimpleText(`Hooks: ${paused ? '⏸ paused' : '▶ active'}`));
        }
        return true;
      }
      case '/sessions': {
        const { store } = getBridgeContext();
        const allSessions = await store.listSessions();
        const binding = await this.router.resolve(msg.channelType, msg.chatId);
        const currentSessionId = binding?.sessionId;

        if (allSessions.length === 0) {
          await adapter.send(msg.chatId, r.renderSimpleText('No sessions found.'));
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

        await adapter.send(msg.chatId, r.renderCommandResponse({
          title: '📋 Sessions',
          body: lines.join('\n') + footer,
          color: 'info',
        }));
        return true;
      }
      case '/session': {
        const idx = parseInt(parts[1], 10);
        if (isNaN(idx) || idx < 1) {
          await adapter.send(msg.chatId, r.renderSimpleText('Usage: /session <number>\nUse /sessions to list.'));
          return true;
        }

        const { store } = getBridgeContext();
        const allSessions = await store.listSessions();
        const sorted = allSessions
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 10);

        if (idx > sorted.length) {
          await adapter.send(msg.chatId, r.renderSimpleText(`Session ${idx} not found. Use /sessions to list.`));
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
        await adapter.send(msg.chatId, r.renderSimpleText(
          `🔄 Switched to session ${idx}\n${preview}\n${hasContext}`,
        ));
        return true;
      }
      case '/runtime': {
        const runtime = parts[1]?.toLowerCase();
        if (isKnownFlavor(runtime)) {
          // Pre-check: reject if Codex SDK not installed
          if (runtime === 'codex' && !await checkCodexAvailable()) {
            await adapter.send(msg.chatId, r.renderSimpleText(
              '❌ Codex SDK not installed.\nRun: `npm install @openai/codex-sdk` in the bridge directory.',
            ));
            return true;
          }
          const prevRuntime = this.state.getRuntime(msg.channelType, msg.chatId) || 'claude';
          this.state.setRuntime(msg.channelType, msg.chatId, runtime);
          // Switching provider → old session ID is invalid for the new provider
          if (prevRuntime !== runtime) {
            const newSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            await this.router.rebind(msg.channelType, msg.chatId, newSessionId);
            this.state.clearLastActive(msg.channelType, msg.chatId);
          }
          const icons: Record<string, string> = { claude: '🟣', codex: '🟢' };
          const text = `${icons[runtime] || '🔄'} Runtime: **${runtime}**`;
          await adapter.send(msg.chatId, r.renderSimpleText(text));
        } else {
          const current = this.state.getRuntime(msg.channelType, msg.chatId) || 'claude';
          const codexStatus = await checkCodexAvailable() ? '✅' : '❌ (not installed)';
          const text = `🔄 Runtime: **${current}**\nUsage: \`/runtime claude|codex\`\nclaude: ✅ · codex: ${codexStatus}`;
          await adapter.send(msg.chatId, r.renderSimpleText(text));
        }
        return true;
      }
      case '/model': {
        const model = parts.slice(1).join(' ').trim();
        const wsForModel = this.workspaceManager?.findByThread(msg.chatId);
        if (model) {
          if (model === 'reset' || model === 'default') {
            if (wsForModel) {
              this.workspaceManager!.update(wsForModel.name, { model: undefined });
              this.workspaceManager!.persist();
            } else {
              this.state.setModel(msg.channelType, msg.chatId, undefined);
            }
            await adapter.send(msg.chatId, r.renderSimpleText('🤖 Model: reset to default' + CommandRouter.MENU_HINT));
          } else {
            if (wsForModel) {
              this.workspaceManager!.update(wsForModel.name, { model });
              this.workspaceManager!.persist();
            } else {
              this.state.setModel(msg.channelType, msg.chatId, model);
            }
            await adapter.send(msg.chatId, r.renderSimpleText(`🤖 Model: **${model}**${CommandRouter.MENU_HINT}`));
          }
        } else {
          const current = wsForModel?.model ?? this.state.getModel(msg.channelType, msg.chatId) ?? 'default';
          const text = `🤖 Model: **${current}**\nUsage: \`/model <name>\` or \`/model reset\`\nExamples: \`claude-sonnet-4-6\`, \`claude-opus-4-6\``;
          await adapter.send(msg.chatId, r.renderSimpleText(text));
        }
        return true;
      }
      case '/settings': {
        const llm = getBridgeContext().llm;
        const arg = parts[1]?.toLowerCase();
        const runtime = this.state.getRuntime(msg.channelType, msg.chatId) || 'claude';
        const wsForSettings = this.workspaceManager?.findByThread(msg.chatId);

        if (runtime === 'codex' || !(llm instanceof ClaudeSDKProvider)) {
          // Codex runtime — show Codex-specific info (workspace values take precedence)
          const model = wsForSettings?.model ?? this.state.getModel(msg.channelType, msg.chatId) ?? 'default';
          const effort = wsForSettings?.effort ?? this.state.getEffort(msg.channelType, msg.chatId) ?? 'default';
          const perm = wsForSettings?.perm ?? this.state.getPermMode(msg.channelType, msg.chatId);
          const wsTag = wsForSettings ? ` [workspace: ${wsForSettings.name}]` : '';
          const text = [
            `⚙️ **Codex Settings**${wsTag}`,
            `  Model: \`${model}\``,
            `  Effort: \`${effort}\``,
            `  Perm: \`${perm}\``,
            '',
            'Use `/model`, `/effort`, `/perm` to change.',
            'Codex sandbox & network settings are set in config.',
          ].join('\n');
          await adapter.send(msg.chatId, r.renderSimpleText(text));
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
          await adapter.send(msg.chatId, r.renderSimpleText(`⚙️ Settings: ${labels[arg]}`));
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
          await adapter.send(msg.chatId, r.renderSimpleText(text));
        }
        return true;
      }
      case '/help': {
        const helpBody = [
          '`/menu` — **⚙️ Control Panel** ✨',
          '`/new` — New conversation',
          '',
          '*Legacy (use /menu instead):*',
          '`/sessions` · `/perm` · `/effort` · `/model` · `/stop` · `/verbose`',
          '',
          '`/runtime claude|codex` — Switch AI provider',
          '`/settings user|full|isolated` — Claude settings scope',
          '`/hooks pause|resume` — Toggle IM approval',
          '`/status` — Bridge status',
          '`/approve <code>` — Approve pairing request',
          '`/help` — This message',
          '',
          '💬 Reply **allow** / **deny** to approve permissions',
        ].join('\n');

        await adapter.send(msg.chatId, r.renderCommandResponse({
          title: '❓ TLive Commands',
          body: helpBody,
          color: 'info',
        }));
        return true;
      }
      case '/approve': {
        const code = parts[1];
        if (!code) {
          await adapter.send(msg.chatId, r.renderSimpleText('Usage: /approve <pairing_code>'));
          return true;
        }
        // Try to approve pairing on Telegram adapter
        const tgAdapter = this.getAdapters().get('telegram');
        if (tgAdapter && 'approvePairing' in tgAdapter) {
          const result = (tgAdapter as any).approvePairing(code);
          if (result) {
            await adapter.send(msg.chatId, r.renderSimpleText(
              `✅ Approved user ${result.username} (${result.userId})`,
            ));
          } else {
            await adapter.send(msg.chatId, r.renderSimpleText('❌ Code not found or expired'));
          }
        } else {
          await adapter.send(msg.chatId, r.renderSimpleText('⚠️ Pairing not available'));
        }
        return true;
      }
      case '/pairings': {
        const tgAdapter = this.getAdapters().get('telegram');
        if (tgAdapter && 'listPairings' in tgAdapter) {
          const pairings = (tgAdapter as any).listPairings() as Array<{ code: string; userId: string; username: string }>;
          if (pairings.length === 0) {
            await adapter.send(msg.chatId, r.renderSimpleText('No pending pairing requests.'));
          } else {
            const lines = pairings.map(p => `\`${p.code}\` — ${p.username} (${p.userId})`);
            await adapter.send(msg.chatId, r.renderCommandResponse({
              title: '🔐 Pending Pairings',
              body: lines.join('\n') + '\n\nUse /approve <code> to approve.',
              color: 'info',
            }));
          }
        } else {
          await adapter.send(msg.chatId, r.renderSimpleText('⚠️ Pairing not available'));
        }
        return true;
      }
      case '/open': {
        const arg = parts[1]?.trim();
        if (!arg) {
          await adapter.send(msg.chatId, r.renderSimpleText('Usage: /open <name|path>'));
          return true;
        }
        if (!this.workspaceManager) {
          await adapter.send(msg.chatId, r.renderSimpleText('Workspaces not configured'));
          return true;
        }
        const runtime = 'codex' as const; // simplification — can be extended later

        let result;
        if (arg.startsWith('/') || arg.startsWith('~') || arg.includes('/')) {
          const resolved = arg.startsWith('~') ? arg.replace(/^~/, process.env.HOME ?? '') : arg;
          result = this.workspaceManager.openByPath(resolved, { chatId: msg.chatId, runtime });
        } else {
          result = this.workspaceManager.openByName(arg, { chatId: msg.chatId });
        }

        if (!result.ok) {
          await adapter.send(msg.chatId, r.renderSimpleText(`❌ ${result.error}`));
          return true;
        }

        const ws = result.workspace;
        if (!ws.threadId && typeof (adapter as any).createTopicIfNeeded === 'function') {
          const threadId = await (adapter as any).createTopicIfNeeded(msg.chatId, ws.name);
          if (threadId) this.workspaceManager.update(ws.name, { threadId });
        }
        this.workspaceManager.persist();

        await adapter.send(msg.chatId, r.renderSimpleText(`📂 Workspace ${ws.name} opened\n${ws.workdir}`));
        return true;
      }
      case '/workspaces': {
        if (!this.workspaceManager) {
          await adapter.send(msg.chatId, r.renderSimpleText('Workspaces not configured'));
          return true;
        }
        const workspaces = this.workspaceManager.list();
        if (workspaces.length === 0) {
          await adapter.send(msg.chatId, r.renderSimpleText('No workspaces. Use /open <name|path> to create one.'));
          return true;
        }
        const lines = ['📁 Workspaces:'];
        for (const ws of workspaces) {
          const marker = ws.activeSessionId ? '●' : '○';
          const state = ws.activeSessionId ? 'running' : 'idle';
          const since = ws.lastActivityAt ? formatSince(ws.lastActivityAt) : 'never';
          lines.push(`${marker} ${ws.name}  ${ws.workdir}  · ${state}  · ${since}`);
        }
        await adapter.send(msg.chatId, r.renderSimpleText(lines.join('\n')));
        return true;
      }
      default:
        return false;
    }
  }
}
