import type { BaseChannelAdapter } from '../channels/base.js';
import type { OutboundMessage } from '../channels/types.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import { loadConfig } from '../config.js';
import { basename } from 'node:path';

/** Data shape for hook notifications (stop, idle_prompt, etc.) from Go Core */
export interface HookNotificationData {
  tlive_hook_type?: string;
  tlive_session_id?: string;
  tlive_cwd?: string;
  notification_type?: string;
  message?: string;
  last_assistant_message?: string;
  last_output?: string;
  [key: string]: unknown;
}

/**
 * Handles hook notification delivery to IM platforms and hook reply routing.
 *
 * Receives notifications from Go Core (stop, idle_prompt, generic) and
 * formats/sends them to the appropriate IM channel.
 */
export class HookEngine {
  constructor(
    private permissions: PermissionCoordinator,
    private coreAvailable: () => boolean,
    private token: string,
    private getLocalIP: () => string,
  ) {}

  /** Send hook notification to IM with context suffix and track for reply routing */
  async sendNotification(adapter: BaseChannelAdapter, chatId: string, hook: HookNotificationData, receiveIdType?: string): Promise<void> {
    const { formatNotification } = await import('../formatting/index.js');
    const hookType = hook.tlive_hook_type || '';

    let title: string;
    let type: 'stop' | 'idle_prompt' | 'generic';
    let summary: string | undefined;

    // Build context suffix: project name + short session ID
    const contextParts: string[] = [];
    if (hook.tlive_cwd) {
      const projectName = basename(hook.tlive_cwd || '') || '';
      if (projectName) contextParts.push(projectName);
    }
    if (hook.tlive_session_id) {
      const shortId = hook.tlive_session_id.slice(-6);
      contextParts.push(`#${shortId}`);
    }
    const contextSuffix = contextParts.length > 0 ? ' · ' + contextParts.join(' · ') : '';

    if (hookType === 'stop') {
      type = 'stop';
      const raw = (hook.last_assistant_message || hook.last_output || '').trim();
      summary = raw ? (raw.length > 3000 ? raw.slice(0, 2997) + '...' : raw) : undefined;
      title = `Terminal${contextSuffix}`;
    } else if (hook.notification_type === 'idle_prompt') {
      title = `Terminal${contextSuffix} · ` + (hook.message || 'Waiting for input...');
      type = 'idle_prompt';
    } else {
      title = hook.message || 'Notification';
      type = 'generic';
    }

    let terminalUrl: string | undefined;
    if (this.coreAvailable() && hook.tlive_session_id) {
      const config = loadConfig();
      const baseUrl = config.publicUrl || `http://${this.getLocalIP()}:${config.port || 4590}`;
      terminalUrl = `${baseUrl}/terminal.html?id=${hook.tlive_session_id}&token=${this.token}`;
    }

    const formatted = formatNotification({ type, title, summary, terminalUrl }, adapter.channelType as any);

    const outMsg: OutboundMessage = {
      chatId,
      text: formatted.text,
      html: formatted.html,
      embed: formatted.embed,
      buttons: (formatted as any).buttons,
      feishuHeader: formatted.feishuHeader,
      feishuElements: (formatted as any).feishuElements,
      receiveIdType,
    };
    const result = await adapter.send(outMsg);
    this.permissions.trackHookMessage(result.messageId, hook.tlive_session_id || '');
  }
}
