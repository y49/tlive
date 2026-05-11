// src/kernel/contracts/runtime-adapter.ts
//
// FROZEN SURFACE — DO NOT MODIFY without bumping major version.

import type { RuntimeEvent } from './runtime-event.js';

export type Provider = 'claude' | 'codex';

export interface PermissionRequestPayload {
  toolName: string;
  input: unknown;
  requestId: string;
}

export type PermissionHandler = (req: PermissionRequestPayload) => Promise<boolean>;

export interface RuntimeAdapter {
  readonly provider: string;

  /** 起一个新 session 或 resume 已有 session。 */
  start(opts: {
    workspaceDir: string;
    resumeProviderSessionId?: string;
    modelOpts?: Record<string, unknown>;
  }): Promise<{ providerSessionId: string }>;

  /** 把 user 消息推进当前 session。 */
  sendUser(text: string): Promise<void>;

  /** 中断当前 turn (不结束 session)。 */
  interrupt(): Promise<void>;

  /** 结束 session (停 query iter,但不动 jsonl)。 */
  stop(): Promise<void>;

  /** 事件流 — kernel subscribe,转给 IM adapter 渲染。 */
  events(): AsyncIterable<RuntimeEvent>;

  /** Permission tool 被调用时 kernel 怎么 hook 进去。 */
  installPermissionHandler(handler: PermissionHandler): void;
}

export type { RuntimeEvent };
