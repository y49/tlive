// src/kernel/contracts/im-adapter.ts
//
// FROZEN SURFACE — DO NOT MODIFY without bumping major version.
// See KERNEL.md.

export type IMChannel = 'telegram' | 'feishu';

export interface IncomingEnvelope {
  channel: IMChannel;
  chatId: string;
  userId: string;
  messageId: string;
  text: string;
  /** Text typed into a card's native input box (Feishu form submit) — rides
   *  alongside text (= the inputAction id that routes it). */
  formText?: string;
  replyToMessageId?: string;
  /** Inbound photos/files, already downloaded by the adapter to a local path
   *  (e.g. ~/.tlive/inbox/). Consumers see filesystem paths only. */
  attachments?: Array<{ name: string; mime: string; localPath: string; sizeBytes: number }>;
  ts: number;
}

export type OutgoingMessage =
  | { kind: 'text'; text: string }
  // inputAction: channels with native text inputs (Feishu form) render an
  // inline reply box; submitting delivers the typed text as formText on the
  // inbound envelope with text = inputAction.id. Channels without inputs (TG)
  // ignore it — quote-reply remains their path.
  | { kind: 'card'; title?: string; body: string; buttons?: Array<{ id: string; label: string }>; inputAction?: { id: string; placeholder: string; submitLabel: string } };

export interface IMAdapter {
  readonly channel: IMChannel;

  /** 启动 (建立长连接 / 启动 webhook listener)。idempotent。 */
  start(): Promise<void>;

  /**
   * 优雅停止。
   * 契约: 调完 stop() 后,在 Node 默认 unref / clearInterval 等机制下,
   * event loop 必须可以自然 drain — 不允许任何 retry timer / long-poll fetch /
   * WS-reconnect 残留 ref'd handle。
   */
  stop(): Promise<void>;

  /** 发消息到 IM,返回 IM 平台的 messageId (供 edit/reply 引用)。 */
  send(out: OutgoingMessage): Promise<{ messageId: string }>;

  /** 编辑已发出的消息 (streaming card 更新用)。 */
  edit(messageId: string, out: OutgoingMessage): Promise<void>;

  /** 注入 inbound 处理器。kernel 启动时调一次。 */
  onInbound(handler: (env: IncomingEnvelope) => void): void;

  /** 健康检查。 */
  isConnected(): 'connected' | 'idle' | 'failed';
}
