import type { ChannelType } from '../channels/types.js';
import { markdownToTelegram } from '../markdown/telegram.js';
import { getToolIcon } from '../engine/tool-registry.js';
import { redactSensitiveContent } from '../engine/content-filter.js';
import type {
  NotificationRenderer, NotificationEvent, ProgressSnapshot,
  CommandResponseData, TelegramOutbound, TodoItem,
} from './types.js';

const SEPARATOR = '───────────────';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncateInput(input: string, max = 300): string {
  return input.length > max ? input.slice(0, max - 3) + '...' : input;
}

/**
 * Truncate permissionId so callback_data stays within Telegram's 64-byte limit.
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
  const header = `<b>Progress (${done}/${items.length})</b>`;
  const lines = items.map(t => {
    const icon = t.status === 'completed' ? '\u2705' : t.status === 'in_progress' ? '\uD83D\uDD27' : '\u2B1C';
    return `${icon} ${escapeHtml(t.content)}`;
  });
  return `${header}\n${lines.join('\n')}`;
}

function renderToolSummary(toolCounts: Map<string, number>, totalTools: number): string {
  const parts: string[] = [];
  for (const [name, count] of toolCounts) {
    parts.push(`${getToolIcon(name)} ${escapeHtml(name)} \u00D7${count}`);
  }
  return `${parts.join(' \u00B7 ')} (${totalTools} total)`;
}

function formatCostLine(costLine: string): string {
  return escapeHtml(costLine);
}

export class TelegramRenderer implements NotificationRenderer<TelegramOutbound> {
  readonly channelType: ChannelType = 'telegram';

  renderNotification(event: NotificationEvent): TelegramOutbound {
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
      case 'reasoning_summary':
        return this.renderReasoningSummary(event);
      case 'file_change_list':
        return this.renderFileChangeList(event);
    }
  }

  renderProgress(snapshot: ProgressSnapshot): TelegramOutbound {
    switch (snapshot.phase) {
      case 'starting':
        return { html: '\u23F3 Starting...' };
      case 'executing':
        return this.renderExecutingPhase(snapshot);
      case 'permission':
        return this.renderPermissionPhase(snapshot);
      case 'completed':
      case 'error':
        return this.renderDonePhase(snapshot);
    }
  }

  renderCommandResponse(data: CommandResponseData): TelegramOutbound {
    const lines: string[] = [];
    lines.push(`<b>${escapeHtml(data.title)}</b>`);
    if (data.body) {
      lines.push('');
      lines.push(markdownToTelegram(data.body));
    }
    if (data.fields && data.fields.length > 0) {
      lines.push('');
      for (const field of data.fields) {
        lines.push(`<b>${escapeHtml(field.name)}:</b> ${escapeHtml(field.value)}`);
      }
    }
    return { html: lines.join('\n'), buttons: data.buttons };
  }

  renderSimpleText(text: string): TelegramOutbound {
    return { html: escapeHtml(text) };
  }

  // ─── Notification kind handlers ─────────────────

  private renderPermissionRequest(event: Extract<NotificationEvent, { kind: 'permission_request' }>): TelegramOutbound {
    const input = truncateInput(event.toolInput);
    const expires = event.expiresInMinutes ?? 5;
    const safeId = safePermissionId(event.permissionId);

    const parts = [
      '\uD83D\uDD10 <b>Permission Required</b>',
      '',
      `<b>Tool:</b> <code>${escapeHtml(event.toolName)}</code>`,
      `<pre>${escapeHtml(input)}</pre>`,
      '',
      `\u23F1 Expires in ${expires} minutes`,
      '',
      '\uD83D\uDCAC Or reply <b>allow</b> / <b>deny</b>',
    ];

    const buttons = [
      { label: '\u2705 Yes', callbackData: `perm:allow:${safeId}`, style: 'primary' as const },
      { label: '\u274C No', callbackData: `perm:deny:${safeId}`, style: 'danger' as const },
    ];

    return { html: parts.join('\n'), buttons };
  }

  private renderAskUserQuestion(event: Extract<NotificationEvent, { kind: 'ask_user_question' }>): TelegramOutbound {
    const lines: string[] = [];
    if (event.header) {
      lines.push(`<b>${escapeHtml(event.header)}</b>`);
      lines.push('');
    }
    lines.push(escapeHtml(event.question));

    const buttons: TelegramOutbound['buttons'] = [];
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

    return { html: lines.join('\n'), buttons };
  }

  private renderSessionComplete(event: Extract<NotificationEvent, { kind: 'session_complete' }>): TelegramOutbound {
    const lines: string[] = [];
    lines.push(markdownToTelegram(event.summary));

    if (event.cost) {
      const tokens = `${formatTokenCount(event.cost.inputTokens + event.cost.outputTokens)} tokens`;
      const duration = formatDuration(event.cost.durationMs);
      const cost = `$${event.cost.costUsd.toFixed(2)}`;
      lines.push('');
      lines.push(`${cost} \u00B7 ${tokens} \u00B7 ${duration}`);
    }

    return { html: lines.join('\n') };
  }

  private renderError(event: Extract<NotificationEvent, { kind: 'error' }>): TelegramOutbound {
    return { html: `\u274C <pre>${escapeHtml(event.message)}</pre>` };
  }

  private renderTodoUpdate(event: Extract<NotificationEvent, { kind: 'todo_update' }>): TelegramOutbound {
    return { html: renderTodoChecklist(event.items) };
  }

  private renderActivityText(event: Extract<NotificationEvent, { kind: 'activity_text' }>): TelegramOutbound {
    return { html: escapeHtml(event.text) };
  }

  private renderActivityTool(event: Extract<NotificationEvent, { kind: 'activity_tool' }>): TelegramOutbound {
    const input = event.toolInput ? ' ' + escapeHtml(event.toolInput) : '';
    return { html: `\u25B8 <code>${escapeHtml(event.toolName)}</code>${input}` };
  }

  private renderThinking(event: Extract<NotificationEvent, { kind: 'thinking' }>): TelegramOutbound {
    if (event.active) {
      return { html: '\uD83E\uDDE0 <i>Thinking...</i>' };
    }
    return { html: '\u2705 <i>Done thinking</i>' };
  }

  private renderReasoningSummary(event: Extract<NotificationEvent, { kind: 'reasoning_summary' }>): TelegramOutbound {
    const duration = event.durationMs ? ` <i>(${Math.round(event.durationMs / 1000)}s)</i>` : '';
    const truncatedNote = event.truncated
      ? ' <i>(truncated — full in web terminal)</i>'
      : '';
    return {
      html: `💭 <b>Reasoning</b>${duration}\n<tg-spoiler>${escapeHtml(event.text)}</tg-spoiler>${truncatedNote}`,
    };
  }

  private renderFileChangeList(event: Extract<NotificationEvent, { kind: 'file_change_list' }>): TelegramOutbound {
    const iconFor = (kind: 'add' | 'delete' | 'update') =>
      kind === 'add' ? '➕' : kind === 'delete' ? '➖' : '✏️';
    const lines = event.changes.map((c) => `${iconFor(c.kind)} <code>${escapeHtml(c.path)}</code>`);
    const header = event.status === 'failed'
      ? `❌ <b>File changes (failed)</b>`
      : `📝 <b>File changes</b>`;
    return { html: `${header}\n${lines.join('\n')}` };
  }

  // ─── Progress phase handlers ────────────────────

  private renderExecutingPhase(snapshot: ProgressSnapshot): TelegramOutbound {
    const lines: string[] = [];

    if (snapshot.responseText.trim()) {
      lines.push(markdownToTelegram(redactSensitiveContent(snapshot.responseText.trim())));
      lines.push('');
    }

    if (snapshot.todoItems.length > 0) {
      lines.push(renderTodoChecklist(snapshot.todoItems));
      lines.push('');
    }

    if (snapshot.totalTools > 0) {
      const toolParts: string[] = [];
      for (const [name, count] of snapshot.toolCounts) {
        toolParts.push(`${getToolIcon(name)} ${escapeHtml(name)} \u00D7${count}`);
      }
      const toolSummary = toolParts.join(' \u00B7 ');
      const elapsed = `${snapshot.elapsedSeconds}s`;
      lines.push(`\u23F3 ${toolSummary} (${snapshot.totalTools} tools \u00B7 ${elapsed})`);
    }

    return { html: lines.join('\n') };
  }

  private renderPermissionPhase(snapshot: ProgressSnapshot): TelegramOutbound {
    if (snapshot.permissionQueue.length === 0) {
      return { html: '\u23F3 Starting...' };
    }

    const p = snapshot.permissionQueue[0];
    const safeId = safePermissionId(p.permId);

    const parts = [
      '\uD83D\uDD10 <b>Permission Required</b>',
      '',
      `<b>Tool:</b> <code>${escapeHtml(p.toolName)}</code>`,
      `<pre>${escapeHtml(p.input)}</pre>`,
    ];

    if (snapshot.permissionQueue.length > 1) {
      parts.push('');
      parts.push(`\u23F3 +${snapshot.permissionQueue.length - 1} more pending`);
    }

    const buttons = p.buttons.map(b => ({
      label: b.label,
      callbackData: b.callbackData,
      style: b.style as 'primary' | 'danger' | 'default',
    }));

    return { html: parts.join('\n'), buttons };
  }

  private renderDonePhase(snapshot: ProgressSnapshot): TelegramOutbound {
    const lines: string[] = [];

    if (snapshot.responseText.trim()) {
      lines.push(markdownToTelegram(redactSensitiveContent(snapshot.responseText.trimEnd())));
      lines.push(SEPARATOR);
    }

    if (snapshot.totalTools > 0) {
      lines.push(renderToolSummary(snapshot.toolCounts, snapshot.totalTools));
    }

    if (snapshot.costLine) {
      lines.push(formatCostLine(snapshot.costLine));
    }

    if (snapshot.errorMessage) {
      lines.push(`\u26A0\uFE0F ${escapeHtml(snapshot.errorMessage)}`);
    }

    return { html: lines.join('\n') };
  }
}

// ─── Helpers ────────────────────────────────────

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
