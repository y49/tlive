import { PendingPermissions } from './gateway.js';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { ChannelType } from '../channels/types.js';
import type { NotificationRenderer, NotificationEvent } from '../renderers/types.js';

export class PermissionBroker {
  private gateway: PendingPermissions;
  private publicUrl: string;
  private renderers: Map<ChannelType, NotificationRenderer>;

  constructor(gateway: PendingPermissions, publicUrl: string, renderers: Map<ChannelType, NotificationRenderer>) {
    this.gateway = gateway;
    this.publicUrl = publicUrl;
    this.renderers = renderers;
  }

  async forwardPermissionRequest(
    request: { permissionRequestId: string; toolName: string; toolInput: unknown },
    getChatId: (channelType: string) => string,
    adapters: BaseChannelAdapter[],
    options?: { showTerminalUrl?: boolean },
  ): Promise<void> {
    const inputStr = typeof request.toolInput === 'string'
      ? request.toolInput
      : JSON.stringify(request.toolInput, null, 2);

    for (const adapter of adapters) {
      const chatId = getChatId(adapter.channelType);
      if (!chatId) continue;

      const renderer = this.renderers.get(adapter.channelType)!;
      const event: NotificationEvent = {
        kind: 'permission_request',
        toolName: request.toolName,
        toolInput: inputStr,
        permissionId: request.permissionRequestId,
        expiresInMinutes: 5,
      };
      await adapter.sendRendered(chatId, renderer.renderNotification(event));
    }
  }

  handlePermissionCallback(callbackData: string): boolean {
    // Format: perm:allow:<id>, perm:deny:<id>, perm:allow_session:<id>
    const match = callbackData.match(/^perm:(allow|deny|allow_session):(.+)$/);
    if (!match) return false;

    const [, action, permId] = match;
    const decision = action === 'deny' ? 'deny' as const
      : action === 'allow_session' ? 'allow_always' as const
      : 'allow' as const;
    return this.gateway.resolve(permId, decision);
  }
}
