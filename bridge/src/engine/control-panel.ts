import type { BaseChannelAdapter } from '../channels/base.js';
import type { SessionStateManager } from './session-state.js';
import type { SDKEngine } from './sdk-engine.js';
import type { ChannelRouter } from './router.js';
import type { OutboundMessage, Button } from '../channels/types.js';
import type { QueryControls } from '../providers/base.js';
import { getBridgeContext } from '../context.js';

/**
 * Button-based control panel for managing TLive sessions.
 * Renders a single card that is edited in-place for sub-menus.
 */
export class ControlPanel {
  constructor(
    private state: SessionStateManager,
    private sdkEngine: SDKEngine,
    private activeControls: Map<string, QueryControls>,
    private router: ChannelRouter,
    private onNewSession?: (channelType: string, chatId: string) => void,
  ) {}

  /** Render the main panel card */
  async show(adapter: BaseChannelAdapter, chatId: string): Promise<void> {
    const msg = this.buildMainPanel(adapter.channelType, chatId);
    await adapter.send(msg);
  }

  /** Handle a panel callback — called by CallbackRouter */
  async handleCallback(
    adapter: BaseChannelAdapter,
    chatId: string,
    messageId: string,
    action: string,
  ): Promise<void> {
    // Strip chatKey suffix from action
    const parts = action.split(':');
    const command = parts[0];

    switch (command) {
      case 'model':
        if (parts[1] === 'select') {
          // panel:model:select:{modelName}:{chatKey}
          const modelName = parts[2];
          if (modelName === 'default') {
            this.state.setModel(adapter.channelType, chatId, undefined);
          } else {
            this.state.setModel(adapter.channelType, chatId, modelName);
          }
          await adapter.editMessage(chatId, messageId, this.buildMainPanel(adapter.channelType, chatId));
        } else {
          await adapter.editMessage(chatId, messageId, this.buildModelPicker(adapter.channelType, chatId));
        }
        break;

      case 'effort':
        if (parts[1] === 'select') {
          const level = parts[2] as 'low' | 'medium' | 'high' | 'max';
          this.state.setEffort(adapter.channelType, chatId, level);
          await adapter.editMessage(chatId, messageId, this.buildMainPanel(adapter.channelType, chatId));
        } else {
          await adapter.editMessage(chatId, messageId, this.buildEffortPicker(adapter.channelType, chatId));
        }
        break;

      case 'perm': {
        const current = this.state.getPermMode(adapter.channelType, chatId);
        this.state.setPermMode(adapter.channelType, chatId, current === 'on' ? 'off' : 'on');
        await adapter.editMessage(chatId, messageId, this.buildMainPanel(adapter.channelType, chatId));
        break;
      }

      case 'sessions':
        await adapter.editMessage(chatId, messageId, await this.buildSessionList(adapter.channelType, chatId));
        break;

      case 'stop': {
        const chatKey = this.state.stateKey(adapter.channelType, chatId);
        const ctrl = this.activeControls.get(chatKey);
        if (ctrl) {
          this.activeControls.delete(chatKey);
          await ctrl.interrupt();
        }
        await adapter.editMessage(chatId, messageId, this.buildMainPanel(adapter.channelType, chatId));
        break;
      }

      case 'stats':
        await adapter.editMessage(chatId, messageId, this.buildStatsCard(adapter.channelType, chatId));
        break;

      case 'session':
        if (parts[1] === 'switch') {
          // panel:session:switch:{sessionId}:{chatKey}
          const targetSessionId = parts[2];
          await this.router.rebind(adapter.channelType, chatId, targetSessionId);
          this.state.clearLastActive(adapter.channelType, chatId);
          await adapter.editMessage(chatId, messageId, this.buildMainPanel(adapter.channelType, chatId));
        } else if (parts[1] === 'new') {
          this.onNewSession?.(adapter.channelType, chatId);
          const newSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          await this.router.rebind(adapter.channelType, chatId, newSessionId);
          this.state.clearLastActive(adapter.channelType, chatId);
          this.state.clearThread(adapter.channelType, chatId);
          await adapter.editMessage(chatId, messageId, this.buildMainPanel(adapter.channelType, chatId));
        }
        break;

      case 'back':
        await adapter.editMessage(chatId, messageId, this.buildMainPanel(adapter.channelType, chatId));
        break;

      default:
        break;
    }
  }

  // ── Card Builders ──────────────────────────────────────────────

  buildMainPanel(channelType: string, chatId: string): OutboundMessage {
    const model = this.state.getModel(channelType, chatId) || 'default';
    const effort = this.state.getEffort(channelType, chatId) || 'default';
    const perm = this.state.getPermMode(channelType, chatId);
    const runtime = this.state.getRuntime(channelType, chatId) || 'claude';
    const chatKey = `${channelType}:${chatId}`;

    const effortIcons: Record<string, string> = { low: '⚡', medium: '🧠', high: '💪', max: '🔥', default: '⚡' };
    const permIcon = perm === 'on' ? '🔒' : '🔓';
    const runtimeIcon = runtime === 'codex' ? '🟢' : '🟣';

    const buttons: Button[] = [
      { label: '🤖 Model', callbackData: `panel:model:${chatKey}`, style: 'default', row: 0 },
      { label: `${effortIcons[effort] || '⚡'} Effort`, callbackData: `panel:effort:${chatKey}`, style: 'default', row: 0 },
      { label: `${permIcon} Perm`, callbackData: `panel:perm:${chatKey}`, style: 'default', row: 0 },
      { label: '📋 Sessions', callbackData: `panel:sessions:${chatKey}`, style: 'default', row: 1 },
      { label: '⏹ Stop', callbackData: `panel:stop:${chatKey}`, style: 'danger', row: 1 },
      { label: '📊 Stats', callbackData: `panel:stats:${chatKey}`, style: 'default', row: 1 },
    ];

    if (channelType === 'telegram') {
      const html = [
        `<b>⚙️ TLive</b>`,
        ``,
        `${runtimeIcon} <code>${runtime}</code>  ·  🤖 <code>${model}</code>`,
        `${effortIcons[effort] || '⚡'} <code>${effort}</code>  ·  ${permIcon} Perm: <code>${perm.toUpperCase()}</code>`,
      ].join('\n');
      return { chatId, html, buttons };
    }

    if (channelType === 'discord') {
      return {
        chatId,
        embed: {
          title: '⚙️ TLive',
          color: 0x3399FF,
          fields: [
            { name: `${runtimeIcon} Runtime`, value: `\`${runtime}\``, inline: true },
            { name: '🤖 Model', value: `\`${model}\``, inline: true },
            { name: `${effortIcons[effort] || '⚡'} Effort`, value: `\`${effort}\``, inline: true },
            { name: `${permIcon} Perm`, value: `\`${perm.toUpperCase()}\``, inline: true },
          ],
        },
        buttons,
      };
    }

    // Feishu
    const body = [
      `${runtimeIcon} ${runtime}  ·  🤖 ${model}`,
      `${effortIcons[effort] || '⚡'} ${effort}  ·  ${permIcon} Perm: ${perm.toUpperCase()}`,
    ].join('\n');
    return {
      chatId,
      text: body,
      feishuHeader: { template: 'blue', title: '⚙️ TLive' },
      buttons,
    };
  }

  buildModelPicker(channelType: string, chatId: string): OutboundMessage {
    const current = this.state.getModel(channelType, chatId) || 'default';
    const runtime = this.state.getRuntime(channelType, chatId) || 'claude';
    const chatKey = `${channelType}:${chatId}`;

    const models = runtime === 'codex'
      ? ['codex-mini', 'o4-mini', 'o3']
      : ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'];

    const buttons: Button[] = models.map((m, i) => ({
      label: m === current ? `✓ ${m}` : m,
      callbackData: `panel:model:select:${m}:${chatKey}`,
      style: m === current ? 'primary' as const : 'default' as const,
      row: i,
    }));

    // Default/reset button on same row as last model
    buttons.push({
      label: current === 'default' ? '✓ default' : 'default',
      callbackData: `panel:model:select:default:${chatKey}`,
      style: current === 'default' ? 'primary' : 'default',
      row: models.length,
    });

    // Back button
    buttons.push({
      label: '↩ Back',
      callbackData: `panel:back:${chatKey}`,
      style: 'default',
      row: models.length + 1,
    });

    return this.renderCard(channelType, chatId, {
      title: '🤖 Select Model',
      body: `Current: ${current}`,
      buttons,
      color: 0x9B59B6,
      feishuTemplate: 'indigo',
    });
  }

  buildEffortPicker(channelType: string, chatId: string): OutboundMessage {
    const current = this.state.getEffort(channelType, chatId) || 'default';
    const chatKey = `${channelType}:${chatId}`;

    const levels = [
      { key: 'low', label: '⚡ Low', row: 0 },
      { key: 'medium', label: '🧠 Medium', row: 0 },
      { key: 'high', label: '💪 High', row: 1 },
      { key: 'max', label: '🔥 Max', row: 1 },
    ];

    const buttons: Button[] = levels.map(l => ({
      label: l.key === current ? `${l.label} ✓` : l.label,
      callbackData: `panel:effort:select:${l.key}:${chatKey}`,
      style: l.key === current ? 'primary' as const : 'default' as const,
      row: l.row,  // 2x2 grid
    }));

    buttons.push({
      label: '↩ Back',
      callbackData: `panel:back:${chatKey}`,
      style: 'default',
      row: 2,
    });

    return this.renderCard(channelType, chatId, {
      title: '⚡ Select Effort',
      body: `Current: ${current}`,
      buttons,
      color: 0xF39C12,
      feishuTemplate: 'orange',
    });
  }

  async buildSessionList(channelType: string, chatId: string): Promise<OutboundMessage> {
    const chatKey = `${channelType}:${chatId}`;

    try {
      const { store } = getBridgeContext();
      const allSessions = await store.listSessions();
      const binding = await this.router.resolve(channelType, chatId);
      const currentSessionId = binding?.sessionId;

      const sorted = allSessions
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 5);

      if (sorted.length === 0) {
        return this.renderCard(channelType, chatId, {
          title: '📋 Sessions',
          body: 'No sessions found.',
          buttons: [
            { label: '➕ New', callbackData: `panel:session:new:${chatKey}`, style: 'primary', row: 0 },
            { label: '↩ Back', callbackData: `panel:back:${chatKey}`, style: 'default', row: 0 },
          ],
          color: 0x3399FF,
          feishuTemplate: 'blue',
        });
      }

      const lines: string[] = [];
      const buttons: Button[] = [];
      for (let i = 0; i < sorted.length; i++) {
        const s = sorted[i];
        const isCurrent = s.id === currentSessionId;
        const msgs = await store.getMessages(s.id);
        const firstUser = msgs.find(m => m.role === 'user');
        const preview = firstUser
          ? (firstUser.content.length > 25 ? firstUser.content.slice(0, 22) + '...' : firstUser.content)
          : '(empty)';
        const ago = this.timeAgo(new Date(s.createdAt));
        const marker = isCurrent ? ' ◀' : '';
        lines.push(`${isCurrent ? '●' : '○'} ${preview} · ${ago}${marker}`);

        if (!isCurrent) {
          buttons.push({
            label: `${i + 1}. Switch`,
            callbackData: `panel:session:switch:${s.id}:${chatKey}`,
            style: 'default',
            row: Math.floor(i / 3),
          });
        }
      }

      // Bottom row: New + Back
      const lastRow = (buttons.length > 0 ? Math.floor((buttons.length - 1) / 3) : 0) + 1;
      buttons.push(
        { label: '➕ New', callbackData: `panel:session:new:${chatKey}`, style: 'primary', row: lastRow },
        { label: '↩ Back', callbackData: `panel:back:${chatKey}`, style: 'default', row: lastRow },
      );

      return this.renderCard(channelType, chatId, {
        title: '📋 Sessions',
        body: lines.join('\n'),
        buttons,
        color: 0x3399FF,
        feishuTemplate: 'blue',
      });
    } catch {
      return this.renderCard(channelType, chatId, {
        title: '📋 Sessions',
        body: 'Unable to load sessions.',
        buttons: [{ label: '↩ Back', callbackData: `panel:back:${chatKey}`, style: 'default', row: 0 }],
        color: 0xE74C3C,
        feishuTemplate: 'red',
      });
    }
  }

  buildStatsCard(channelType: string, chatId: string): OutboundMessage {
    const chatKey = `${channelType}:${chatId}`;
    const tracker = this.sdkEngine.getCostTracker(channelType, chatId);
    const backBtn: Button = { label: '↩ Back', callbackData: `panel:back:${chatKey}`, style: 'default', row: 0 };

    if (!tracker || tracker.queryCount === 0) {
      return this.renderCard(channelType, chatId, {
        title: '📊 Session Stats',
        body: 'No stats available yet.\nSend a message to start tracking.',
        buttons: [backBtn],
        color: 0x95A5A6,
        feishuTemplate: 'grey',
      });
    }

    const queries = tracker.queryCount;
    const cost = `$${tracker.sessionTotalUsd.toFixed(2)}`;

    if (channelType === 'discord') {
      return {
        chatId,
        embed: {
          title: '📊 Session Stats',
          color: 0x2ECC71,
          fields: [
            { name: '💬 Queries', value: `\`${queries}\``, inline: true },
            { name: '💰 Cost', value: `\`${cost}\``, inline: true },
          ],
        },
        buttons: [backBtn],
      };
    }

    if (channelType === 'telegram') {
      const html = [
        `<b>📊 Session Stats</b>`,
        ``,
        `💬 Queries: <code>${queries}</code>`,
        `💰 Cost: <code>${cost}</code>`,
      ].join('\n');
      return { chatId, html, buttons: [backBtn] };
    }

    // Feishu
    return {
      chatId,
      text: `💬 Queries: ${queries}\n💰 Cost: ${cost}`,
      feishuHeader: { template: 'green', title: '📊 Session Stats' },
      buttons: [backBtn],
    };
  }

  // ── Rendering helpers ──────────────────────────────────────────

  private renderCard(
    channelType: string,
    chatId: string,
    opts: { title: string; body: string; buttons: Button[]; color: number; feishuTemplate: string },
  ): OutboundMessage {
    if (channelType === 'telegram') {
      return {
        chatId,
        html: `<b>${opts.title}</b>\n\n${this.escapeHtml(opts.body)}`,
        buttons: opts.buttons,
      };
    }

    if (channelType === 'discord') {
      return {
        chatId,
        embed: {
          title: opts.title,
          description: opts.body,
          color: opts.color,
        },
        buttons: opts.buttons,
      };
    }

    // Feishu
    return {
      chatId,
      text: opts.body,
      feishuHeader: { template: opts.feishuTemplate, title: opts.title },
      buttons: opts.buttons,
    };
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private timeAgo(date: Date): string {
    const diff = Date.now() - date.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}
