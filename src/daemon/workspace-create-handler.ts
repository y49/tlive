// src/daemon/workspace-create-handler.ts
//
// Extracted from bootstrap.ts so the create-from-IM dialog flow can be
// driven from integration tests without spinning the entire daemon.
//
// Validation order (per spec §7):
//   1. expand `~`/`$HOME`
//   2. fs.stat + isDirectory
//   3. WorkspaceManager.findByWorkdir guard (already-registered)
//   4. WorkspaceManager.createFromIM (atomic create + claimAdmin + addBinding)
//
// On any failure (1-4) we reply an error message but PRESERVE the pending
// state so the user can simply re-send the corrected path without re-clicking
// the button. Success: resolve() removes pending state, reply success.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { WorkspaceManager } from '../workspace/manager.js';
import type { WorkspaceCreateBroker, PendingCreate } from '../im/workspace-create-broker.js';
import type { PlatformAdapter, InboundEvent } from '../platform/types.js';
import type { Logger } from '../util/logger.js';

export interface WorkspaceCreateHandlerDeps {
  adapter: PlatformAdapter;
  workspaces: WorkspaceManager;
  workspaceCreateBroker: WorkspaceCreateBroker;
  logger: Logger;
}

/**
 * Attempt to create a workspace from a freeform path the user typed in
 * response to the [➕ 新增工作区] prompt. See module header for validation
 * order and error semantics.
 */
export async function tryCreateWorkspaceFromPath(
  rawPath: string,
  pending: PendingCreate,
  deps: WorkspaceCreateHandlerDeps,
  ev: InboundEvent,
): Promise<void> {
  const expanded = expandHome(rawPath.trim());

  try {
    const st = await stat(expanded);
    if (!st.isDirectory()) {
      await deps.adapter.send({
        chatId: ev.chatId,
        threadId: ev.threadId,
        text: `❌ ${expanded} 不是目录，请重发或 /cancel`,
      }).catch(() => undefined);
      return;
    }
  } catch {
    await deps.adapter.send({
      chatId: ev.chatId,
      threadId: ev.threadId,
      text: `❌ 无法访问 ${expanded}，请重发或 /cancel`,
    }).catch(() => undefined);
    return;
  }

  if (deps.workspaces.findByWorkdir(expanded)) {
    await deps.adapter.send({
      chatId: ev.chatId,
      threadId: ev.threadId,
      text: '❌ 该目录已注册为工作区，请用 /workspace 切换',
    }).catch(() => undefined);
    return;
  }

  let ws;
  try {
    ws = deps.workspaces.createFromIM({
      workdir: expanded,
      adminUserId: pending.userId,
      channelType: pending.channelType,
      chatId: pending.chatId,
      threadId: ev.threadId,
    });
    await deps.workspaces.save();
  } catch (err) {
    deps.logger.warn('createFromIM failed', { reason: (err as Error).message });
    await deps.adapter.send({
      chatId: ev.chatId,
      threadId: ev.threadId,
      text: `❌ 创建失败: ${(err as Error).message}`,
    }).catch(() => undefined);
    return;
  }

  deps.workspaceCreateBroker.resolve(pending.channelType, pending.chatId);
  await deps.adapter.send({
    chatId: ev.chatId,
    threadId: ev.threadId,
    text: [
      `✅ 工作区 "${ws.name}" 已创建并关联此 chat`,
      `   📂 ${ws.workdir}`,
      `   🤖 默认: ${ws.defaults.provider} · ${ws.defaults.permissionMode}`,
    ].join('\n'),
  }).catch(() => undefined);
  deps.logger.info('workspace created from IM', { workspaceId: ws.id, workdir: ws.workdir });
}

export function expandHome(p: string): string {
  if (p === '~') return process.env.HOME ?? '';
  if (p.startsWith('~/')) return join(process.env.HOME ?? '', p.slice(2));
  if (p.startsWith('$HOME/')) return join(process.env.HOME ?? '', p.slice(6));
  if (p === '$HOME') return process.env.HOME ?? '';
  return p;
}
