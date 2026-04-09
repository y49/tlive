import type { ChannelType } from '../channels/types.js';
import { getToolIcon } from '../engine/tool-registry.js';
import { redactSensitiveContent } from '../engine/content-filter.js';
import type {
  NotificationRenderer, NotificationEvent, ProgressSnapshot,
  CommandResponseData, DiscordOutbound, DiscordEmbed, TodoItem,
} from './types.js';

// ─── Color constants ───────────────────────────
const COLOR_ORANGE  = 0xFFA500;
const COLOR_BLUE    = 0x3399FF;
const COLOR_GREEN   = 0x00CC66;
const COLOR_RED     = 0xFF4444;
const COLOR_TEAL    = 0x00CED1;
const COLOR_GRAY    = 0x888888;

const HINT_COLOR_MAP: Record<string, number> = {
  success: COLOR_GREEN,
  warning: COLOR_ORANGE,
  info:    COLOR_BLUE,
  error:   COLOR_RED,
};

// ─── Helpers ───────────────────────────────────

function truncateInput(input: string, max = 300): string {
  return input.length > max ? input.slice(0, max - 3) + '...' : input;
}

/**
 * Truncate permissionId so callback_data stays within 64-byte limit.
 * The longest prefix is "perm:allow:" (11 bytes).
 */
function safePermissionId(permissionId: string): string {
  const maxIdBytes = 64 - Buffer.byteLength('perm:allow:', 'utf8');
  return Buffer.byteLength(permissionId, 'utf8') > maxIdBytes
    ? permissionId.slice(0, maxIdBytes)
    : permissionId;
}

function renderTodoChecklist(items: TodoItem[]): string {
  const done = items.filter(t => t.status === 'completed').length;
  const header = `**Progress (${done}/${items.length})**`;
  const lines = items.map(t => {
    const icon = t.status === 'completed' ? '\u2705' : t.status === 'in_progress' ? '\uD83D\uDD27' : '\u2B1C';
    return `${icon} ${t.content}`;
  });
  return `${header}\n${lines.join('\n')}`;
}

function renderToolSummary(toolCounts: Map<string, number>, totalTools: number): string {
  const parts: string[] = [];
  for (const [name, count] of toolCounts) {
    parts.push(`${getToolIcon(name)} ${name} \u00D7${count}`);
  }
  return `${parts.join(' \u00B7 ')} (${totalTools} total)`;
}

function embed(partial: Partial<DiscordEmbed>): DiscordOutbound {
  return { embed: partial as DiscordEmbed };
}

// ─── DiscordRenderer ───────────────────────────

export class DiscordRenderer implements NotificationRenderer<DiscordOutbound> {
  readonly channelType: ChannelType = 'discord';

  renderNotification(event: NotificationEvent): DiscordOutbound {
    switch (event.kind) {
      case 'permission_request':
        return this.renderPermissionRequest(event);
      case 'ask_user_question':
        return this.renderAskUserQuestion(event);
      case 'session_complete':
        return this.renderSessionComplete(event);
      case 'error':
        return this.renderError(event);
      case 'todo_update':
        return this.renderTodoUpdate(event);
      case 'activity_text':
        return this.renderActivityText(event);
      case 'activity_tool':
        return this.renderActivityTool(event);
      case 'thinking':
        return this.renderThinking(event);
    }
  }

  renderProgress(snapshot: ProgressSnapshot): DiscordOutbound {
    switch (snapshot.phase) {
      case 'starting':
        return embed({ description: '\u23F3 Starting...', color: COLOR_GRAY });
      case 'executing':
        return this.renderExecutingPhase(snapshot);
      case 'permission':
        return this.renderPermissionPhase(snapshot);
      case 'completed':
      case 'error':
        return this.renderDonePhase(snapshot);
    }
  }

  renderCommandResponse(data: CommandResponseData): DiscordOutbound {
    const fields = data.fields?.map(f => ({ name: f.name, value: f.value, inline: f.inline }));
    const color = data.color ? HINT_COLOR_MAP[data.color] ?? COLOR_GRAY : COLOR_GRAY;

    return {
      embed: {
        title: data.title,
        description: data.body,
        color,
        fields: fields && fields.length > 0 ? fields : undefined,
      },
      buttons: data.buttons,
    };
  }

  renderSimpleText(text: string): DiscordOutbound {
    return embed({ description: text });
  }

  // ─── Notification kind handlers ─────────────────

  private renderPermissionRequest(event: Extract<NotificationEvent, { kind: 'permission_request' }>): DiscordOutbound {
    const input = truncateInput(event.toolInput);
    const expires = event.expiresInMinutes ?? 5;
    const safeId = safePermissionId(event.permissionId);

    const fields = [
      { name: '\uD83D\uDD27 Tool', value: `\`${event.toolName}\``, inline: true },
      { name: '\u23F1 Expires', value: `${expires} min`, inline: true },
    ];

    const buttons = [
      { label: '\u2705 Yes', callbackData: `perm:allow:${safeId}`, style: 'primary' as const },
      { label: '\u274C No', callbackData: `perm:deny:${safeId}`, style: 'danger' as const },
    ];

    return {
      embed: {
        title: '\uD83D\uDD10 Permission Required',
        color: COLOR_ORANGE,
        description: `\`\`\`\n${input}\n\`\`\``,
        fields,
      },
      buttons,
    };
  }

  private renderAskUserQuestion(event: Extract<NotificationEvent, { kind: 'ask_user_question' }>): DiscordOutbound {
    const parts: string[] = [];
    if (event.header) {
      parts.push(`**${event.header}**`);
      parts.push('');
    }
    parts.push(event.question);

    const buttons: DiscordOutbound['buttons'] = [];
    if (event.options && event.options.length > 0) {
      for (let i = 0; i < event.options.length; i++) {
        buttons.push({
          label: event.options[i].label,
          callbackData: `askq:${event.toolUseId}:${i}`,
        });
      }
    }
    buttons.push({
      label: '\u23ED Skip',
      callbackData: `askq:${event.toolUseId}:skip`,
    });

    return {
      embed: {
        title: '\u2753 Question',
        color: COLOR_BLUE,
        description: parts.join('\n'),
      },
      buttons,
    };
  }

  private renderSessionComplete(event: Extract<NotificationEvent, { kind: 'session_complete' }>): DiscordOutbound {
    const description = event.summary.length > 500
      ? `\`\`\`\n${event.summary.slice(0, 497)}...\n\`\`\``
      : event.summary;

    let footer: string | undefined;
    if (event.cost) {
      const tokens = formatTokenCount(event.cost.inputTokens + event.cost.outputTokens);
      const duration = formatDuration(event.cost.durationMs);
      const cost = `$${event.cost.costUsd.toFixed(2)}`;
      footer = `${cost} \u00B7 ${tokens} tokens \u00B7 ${duration}`;
    }

    return {
      embed: {
        title: '\u2705 Session Complete',
        color: COLOR_GREEN,
        description,
        footer,
      },
    };
  }

  private renderError(event: Extract<NotificationEvent, { kind: 'error' }>): DiscordOutbound {
    return {
      embed: {
        title: '\u274C Error',
        color: COLOR_RED,
        description: `\`\`\`\n${event.message}\n\`\`\``,
      },
    };
  }

  private renderTodoUpdate(event: Extract<NotificationEvent, { kind: 'todo_update' }>): DiscordOutbound {
    return {
      embed: {
        color: COLOR_TEAL,
        description: renderTodoChecklist(event.items),
      },
    };
  }

  private renderActivityText(event: Extract<NotificationEvent, { kind: 'activity_text' }>): DiscordOutbound {
    return embed({ color: COLOR_GRAY, description: event.text });
  }

  private renderActivityTool(event: Extract<NotificationEvent, { kind: 'activity_tool' }>): DiscordOutbound {
    const input = event.toolInput ? ' ' + event.toolInput : '';
    return embed({ color: COLOR_GRAY, description: `\u25B8 ${event.toolName}${input}` });
  }

  private renderThinking(event: Extract<NotificationEvent, { kind: 'thinking' }>): DiscordOutbound {
    if (event.active) {
      return embed({ color: COLOR_GRAY, description: '\uD83E\uDDE0 Thinking...' });
    }
    return embed({ description: '' });
  }

  // ─── Progress phase handlers ────────────────────

  private renderExecutingPhase(snapshot: ProgressSnapshot): DiscordOutbound {
    const parts: string[] = [];

    if (snapshot.responseText.trim()) {
      parts.push(redactSensitiveContent(snapshot.responseText.trim()));
      parts.push('');
    }

    if (snapshot.todoItems.length > 0) {
      parts.push(renderTodoChecklist(snapshot.todoItems));
      parts.push('');
    }

    let footer: string | undefined;
    if (snapshot.totalTools > 0) {
      const toolParts: string[] = [];
      for (const [name, count] of snapshot.toolCounts) {
        toolParts.push(`${getToolIcon(name)} ${name} \u00D7${count}`);
      }
      footer = `${toolParts.join(' \u00B7 ')} (${snapshot.totalTools} tools \u00B7 ${snapshot.elapsedSeconds}s)`;
    }

    return {
      embed: {
        color: COLOR_BLUE,
        description: parts.join('\n') || undefined,
        footer,
      },
    };
  }

  private renderPermissionPhase(snapshot: ProgressSnapshot): DiscordOutbound {
    if (snapshot.permissionQueue.length === 0) {
      return embed({ description: '\u23F3 Starting...', color: COLOR_GRAY });
    }

    const p = snapshot.permissionQueue[0];
    const safeId = safePermissionId(p.permId);

    const description = `\`\`\`\n${p.input}\n\`\`\``;
    const fields = [
      { name: '\uD83D\uDD27 Tool', value: `\`${p.toolName}\``, inline: true },
    ];

    if (snapshot.permissionQueue.length > 1) {
      fields.push({
        name: '\u23F3 Pending',
        value: `+${snapshot.permissionQueue.length - 1} more`,
        inline: true,
      });
    }

    const buttons = p.buttons.map(b => ({
      label: b.label,
      callbackData: b.callbackData,
      style: b.style as 'primary' | 'danger' | 'default',
    }));

    return {
      embed: {
        title: '\uD83D\uDD10 Permission Required',
        color: COLOR_ORANGE,
        description,
        fields,
      },
      buttons,
    };
  }

  private renderDonePhase(snapshot: ProgressSnapshot): DiscordOutbound {
    const parts: string[] = [];

    if (snapshot.responseText.trim()) {
      parts.push(redactSensitiveContent(snapshot.responseText.trimEnd()));
    }

    let footer: string | undefined;
    const footerParts: string[] = [];

    if (snapshot.totalTools > 0) {
      footerParts.push(renderToolSummary(snapshot.toolCounts, snapshot.totalTools));
    }

    if (snapshot.costLine) {
      footerParts.push(snapshot.costLine);
    }

    if (footerParts.length > 0) {
      footer = footerParts.join(' | ');
    }

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
    if (snapshot.errorMessage) {
      fields.push({ name: '\u26A0\uFE0F Error', value: snapshot.errorMessage });
    }

    const color = snapshot.phase === 'error' ? COLOR_RED : COLOR_GREEN;

    return {
      embed: {
        color,
        description: parts.join('\n') || undefined,
        footer,
        fields: fields.length > 0 ? fields : undefined,
      },
    };
  }
}

// ─── Formatting helpers ────────────────────────

function formatTokenCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}
