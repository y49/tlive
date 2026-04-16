import type { ChannelType } from '../channels/types.js';
import { downgradeHeadings } from '../markdown/feishu.js';
import { getToolIcon } from '../engine/tool-registry.js';
import { redactSensitiveContent } from '../engine/content-filter.js';
import type {
  NotificationRenderer, NotificationEvent, ProgressSnapshot,
  CommandResponseData, FeishuOutbound, TodoItem,
} from './types.js';

type FeishuHeaderTemplate = 'orange' | 'green' | 'blue' | 'red' | 'turquoise' | 'grey';

interface CardElement {
  tag: string;
  content?: string;
  [key: string]: unknown;
}

function truncateInput(input: string, max = 300): string {
  return input.length > max ? input.slice(0, max - 3) + '...' : input;
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

function buildCard(
  template: FeishuHeaderTemplate,
  title: string,
  elements: CardElement[],
): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    body: {
      elements,
    },
  });
}

const COLOR_MAP: Record<string, FeishuHeaderTemplate> = {
  success: 'green',
  warning: 'orange',
  info: 'blue',
  error: 'red',
};

export class FeishuRenderer implements NotificationRenderer<FeishuOutbound> {
  readonly channelType: ChannelType = 'feishu';

  renderNotification(event: NotificationEvent): FeishuOutbound {
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

  renderProgress(snapshot: ProgressSnapshot): FeishuOutbound {
    switch (snapshot.phase) {
      case 'starting':
        return {
          card: buildCard('turquoise', '\u23F3 Starting', [
            { tag: 'markdown', content: 'Starting...' },
          ]),
        };
      case 'executing':
        return this.renderExecutingPhase(snapshot);
      case 'permission':
        return this.renderPermissionPhase(snapshot);
      case 'completed':
      case 'error':
        return this.renderDonePhase(snapshot);
    }
  }

  renderCommandResponse(data: CommandResponseData): FeishuOutbound {
    const template = data.color ? COLOR_MAP[data.color] : 'blue';
    const elements: CardElement[] = [];

    if (data.body) {
      elements.push({ tag: 'markdown', content: downgradeHeadings(data.body) });
    }

    if (data.fields && data.fields.length > 0) {
      if (elements.length > 0) {
        elements.push({ tag: 'hr' });
      }
      const fieldLines = data.fields.map(f => `**${f.name}:** ${f.value}`);
      elements.push({ tag: 'markdown', content: fieldLines.join('\n') });
    }

    if (elements.length === 0) {
      elements.push({ tag: 'markdown', content: ' ' });
    }

    // Embed buttons as Feishu V2 card elements (V2 doesn't support tag:'action' wrapper)
    if (data.buttons?.length) {
      const columns = data.buttons.map(b => ({
        tag: 'column',
        width: 'auto',
        vertical_align: 'center',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: b.label },
          type: b.style === 'danger' ? 'danger' : 'primary',
          value: { action: b.callbackData },
        }],
      }));
      elements.push({
        tag: 'column_set',
        flex_mode: 'none',
        background_style: 'default',
        columns,
      } as unknown as CardElement);
    }

    return {
      card: buildCard(template, data.title, elements),
    };
  }

  renderSimpleText(text: string): FeishuOutbound {
    // Minimal card — no header (avoids the heavy "Message" wrapper for
    // status line / short replies)
    return {
      card: JSON.stringify({
        schema: '2.0',
        config: { wide_screen_mode: true },
        body: { elements: [{ tag: 'markdown', content: text }] },
      }),
    };
  }

  // ─── Notification kind handlers ─────────────────

  private renderPermissionRequest(event: Extract<NotificationEvent, { kind: 'permission_request' }>): FeishuOutbound {
    const input = truncateInput(event.toolInput);
    const expires = event.expiresInMinutes ?? 5;

    const elements: CardElement[] = [
      { tag: 'markdown', content: `**Tool:** ${event.toolName}` },
      { tag: 'markdown', content: `\`\`\`\n${input}\n\`\`\`` },
      { tag: 'markdown', content: `\u23F1 Expires in ${expires} minutes` },
      { tag: 'hr' },
      { tag: 'markdown', content: '\uD83D\uDCAC Reply **allow** / **deny** to approve' },
    ];

    const buttons = [
      { label: '\u2705 Allow', callbackData: `perm:allow:${event.permissionId}`, style: 'primary' as const },
      { label: '\u274C Deny', callbackData: `perm:deny:${event.permissionId}`, style: 'danger' as const },
      { label: '\uD83D\uDED1 Stop session', callbackData: `perm:stop:${event.permissionId}`, style: 'danger' as const },
    ];

    return {
      card: buildCard('orange', '\uD83D\uDD10 Permission Required', elements),
      buttons,
    };
  }

  private renderAskUserQuestion(event: Extract<NotificationEvent, { kind: 'ask_user_question' }>): FeishuOutbound {
    const elements: CardElement[] = [];

    if (event.header) {
      elements.push({ tag: 'markdown', content: `**${event.header}**` });
    }
    elements.push({ tag: 'markdown', content: event.question });

    const buttons: FeishuOutbound['buttons'] = [];
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
      card: buildCard('blue', '\u2753 Question', elements),
      buttons,
    };
  }

  private renderSessionComplete(event: Extract<NotificationEvent, { kind: 'session_complete' }>): FeishuOutbound {
    const elements: CardElement[] = [];

    elements.push({ tag: 'markdown', content: downgradeHeadings(event.summary) });

    if (event.cost) {
      const tokens = formatTokenCount(event.cost.inputTokens + event.cost.outputTokens);
      const duration = formatDuration(event.cost.durationMs);
      const cost = `$${event.cost.costUsd.toFixed(2)}`;
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'markdown',
        content: `${cost} \u00B7 ${tokens} tokens \u00B7 ${duration}`,
      });
    }

    return {
      card: buildCard('green', '\u2705 Done', elements),
    };
  }

  private renderError(event: Extract<NotificationEvent, { kind: 'error' }>): FeishuOutbound {
    return {
      card: buildCard('red', '\u274C Error', [
        { tag: 'markdown', content: `\`\`\`\n${event.message}\n\`\`\`` },
      ]),
    };
  }

  private renderTodoUpdate(event: Extract<NotificationEvent, { kind: 'todo_update' }>): FeishuOutbound {
    return {
      card: buildCard('turquoise', '\uD83D\uDCCB Progress', [
        { tag: 'markdown', content: renderTodoChecklist(event.items) },
      ]),
    };
  }

  private renderActivityText(event: Extract<NotificationEvent, { kind: 'activity_text' }>): FeishuOutbound {
    return {
      card: buildCard('turquoise', '\uD83D\uDCDD Activity', [
        { tag: 'markdown', content: event.text },
      ]),
    };
  }

  private renderActivityTool(event: Extract<NotificationEvent, { kind: 'activity_tool' }>): FeishuOutbound {
    const icon = getToolIcon(event.toolName);
    const inputLine = event.toolInput ? `\n${event.toolInput}` : '';
    return {
      card: buildCard('turquoise', `${icon} ${event.toolName}`, [
        { tag: 'markdown', content: `\u25B8 \`${event.toolName}\`${inputLine}` },
      ]),
    };
  }

  private renderThinking(event: Extract<NotificationEvent, { kind: 'thinking' }>): FeishuOutbound {
    if (event.active) {
      return {
        card: buildCard('grey', '\uD83E\uDDE0 Thinking', [
          { tag: 'markdown', content: '*Thinking...*' },
        ]),
      };
    }
    return {
      card: buildCard('green', '\uD83D\uDC4C Done thinking', [
        { tag: 'markdown', content: '*Done thinking*' },
      ]),
    };
  }

  private renderReasoningSummary(event: Extract<NotificationEvent, { kind: 'reasoning_summary' }>): FeishuOutbound {
    const duration = event.durationMs ? ` (${Math.round(event.durationMs / 1000)}s)` : '';
    const truncatedNote = event.truncated ? '\n\n*(truncated — full content in web terminal)*' : '';
    const content = `${event.text}${duration}${truncatedNote}`;
    return {
      card: buildCard('grey', '💭 Reasoning', [
        { tag: 'markdown', content },
      ]),
    };
  }

  private renderFileChangeList(event: Extract<NotificationEvent, { kind: 'file_change_list' }>): FeishuOutbound {
    const iconFor = (kind: 'add' | 'delete' | 'update') =>
      kind === 'add' ? '➕' : kind === 'delete' ? '➖' : '✏️';
    const lines = event.changes.map((c) => `${iconFor(c.kind)} \`${c.path}\``);
    const header = event.status === 'failed' ? '❌ File changes (failed)' : '📝 File changes';
    const template = event.status === 'failed' ? 'red' : 'grey';
    return {
      card: buildCard(template, header, [{ tag: 'markdown', content: lines.join('\n') }]),
    };
  }

  // ─── Progress phase handlers ────────────────────

  private renderExecutingPhase(snapshot: ProgressSnapshot): FeishuOutbound {
    const elements: CardElement[] = [];

    if (snapshot.responseText.trim()) {
      elements.push({
        tag: 'markdown',
        content: downgradeHeadings(redactSensitiveContent(snapshot.responseText.trim())),
      });
    }

    if (snapshot.todoItems.length > 0) {
      elements.push({
        tag: 'markdown',
        content: renderTodoChecklist(snapshot.todoItems),
      });
    }

    if (snapshot.totalTools > 0) {
      const toolParts: string[] = [];
      for (const [name, count] of snapshot.toolCounts) {
        toolParts.push(`${getToolIcon(name)} ${name} \u00D7${count}`);
      }
      const toolSummary = toolParts.join(' \u00B7 ');
      const elapsed = `${snapshot.elapsedSeconds}s`;
      elements.push({
        tag: 'markdown',
        content: `\u23F3 ${toolSummary} (${snapshot.totalTools} tools \u00B7 ${elapsed})`,
      });
    }

    if (elements.length === 0) {
      elements.push({ tag: 'markdown', content: '\u23F3 Working...' });
    }

    return {
      card: buildCard('turquoise', '\u2699\uFE0F Executing', elements),
    };
  }

  private renderPermissionPhase(snapshot: ProgressSnapshot): FeishuOutbound {
    if (snapshot.permissionQueue.length === 0) {
      return {
        card: buildCard('turquoise', '\u23F3 Starting', [
          { tag: 'markdown', content: 'Starting...' },
        ]),
      };
    }

    const p = snapshot.permissionQueue[0];
    const elements: CardElement[] = [
      { tag: 'markdown', content: `**Tool:** ${p.toolName}` },
      { tag: 'markdown', content: `\`\`\`\n${p.input}\n\`\`\`` },
    ];

    if (snapshot.permissionQueue.length > 1) {
      elements.push({
        tag: 'markdown',
        content: `\u23F3 +${snapshot.permissionQueue.length - 1} more pending`,
      });
    }

    // Embed buttons as Feishu V2 card elements (V2 doesn't support tag:'action' wrapper)
    if (p.buttons.length > 0) {
      const columns = p.buttons.map(b => ({
        tag: 'column',
        width: 'auto',
        vertical_align: 'center',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: b.label },
          type: b.style === 'danger' ? 'danger' : 'primary',
          value: { action: b.callbackData },
        }],
      }));
      elements.push({
        tag: 'column_set',
        flex_mode: 'none',
        background_style: 'default',
        columns,
      } as unknown as CardElement);
    }

    return {
      card: buildCard('orange', '\uD83D\uDD10 Permission Required', elements),
    };
  }

  private renderDonePhase(snapshot: ProgressSnapshot): FeishuOutbound {
    const elements: CardElement[] = [];

    if (snapshot.responseText.trim()) {
      elements.push({
        tag: 'markdown',
        content: downgradeHeadings(redactSensitiveContent(snapshot.responseText.trimEnd())),
      });
      elements.push({ tag: 'hr' });
    }

    if (snapshot.todoItems.length > 0) {
      elements.push({
        tag: 'markdown',
        content: renderTodoChecklist(snapshot.todoItems),
      });
    }

    if (snapshot.totalTools > 0) {
      elements.push({
        tag: 'markdown',
        content: renderToolSummary(snapshot.toolCounts, snapshot.totalTools),
      });
    }

    if (snapshot.costLine) {
      elements.push({
        tag: 'markdown',
        content: snapshot.costLine,
      });
    }

    if (snapshot.errorMessage) {
      elements.push({
        tag: 'markdown',
        content: `\u26A0\uFE0F ${snapshot.errorMessage}`,
      });
    }

    if (elements.length === 0) {
      elements.push({ tag: 'markdown', content: 'Completed.' });
    }

    const template: FeishuHeaderTemplate = snapshot.phase === 'error' ? 'red' : 'green';
    const title = snapshot.phase === 'error' ? '\u274C Error' : '\u2705 Done';

    return {
      card: buildCard(template, title, elements),
    };
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
