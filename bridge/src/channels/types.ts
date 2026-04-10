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
