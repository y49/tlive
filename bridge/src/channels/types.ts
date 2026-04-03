export type ChannelType = 'telegram' | 'discord' | 'feishu';

export interface InboundMessage {
  channelType: ChannelType;
  chatId: string;
  userId: string;
  text: string;
  attachments?: FileAttachment[];
  callbackData?: string;
  messageId: string;
  replyToMessageId?: string;
  /** Telegram topic thread ID / Discord thread ID */
  threadId?: string;
}

export interface FileAttachment {
  type: 'image' | 'file';
  name: string;
  mimeType: string;
  base64Data: string;
}

export interface OutboundMessage {
  chatId: string;
  text?: string;
  html?: string;
  buttons?: Button[];
  replyToMessageId?: string;
  /** Telegram topic thread ID / Discord thread ID */
  threadId?: string;
  /** Feishu: override receive_id_type (default 'chat_id', can be 'open_id' for P2P) */
  receiveIdType?: string;
  /** Discord embed for rich formatting */
  embed?: {
    title?: string;
    description?: string;
    color?: number;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    footer?: string;
  };
  /** Feishu card header (template color + title) */
  feishuHeader?: {
    template: string;
    title: string;
  };
  /** Feishu Card 2.0: override card body elements directly (bypasses text→markdown conversion) */
  feishuElements?: Array<Record<string, unknown>>;
  /** Media attachment to send (image or file) */
  media?: {
    type: 'image' | 'file';
    /** URL to fetch, or data URI (data:image/png;base64,...) */
    url?: string;
    /** Raw buffer data */
    buffer?: Buffer;
    /** Filename for file attachments */
    filename?: string;
    /** MIME type */
    mimeType?: string;
  };
}

export interface SendResult {
  messageId: string;
  success: boolean;
}

export interface Button {
  label: string;
  callbackData: string;
  style?: 'primary' | 'danger' | 'default';
  /** URL button: opens link directly instead of sending callback */
  url?: string;
  /** Row index for layout grouping. Buttons with same row are on one line. */
  row?: number;
}
