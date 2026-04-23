// src/platform/telegram/attachment.ts
//
// Upload/download helpers for Telegram. Uses grammy's InputFile for sends
// and getFile + fetch for receives.

import { createReadStream } from 'node:fs';
import { InputFile, type Bot } from 'grammy';
import type { OutboundAttachment } from '../types.js';

export interface SendAttachmentInput {
  chatId: string;
  attachment: OutboundAttachment;
  caption?: string;
  threadId?: string;
  replyMarkup?: object;
}

/**
 * Send a file as document (fallback for everything) or photo (image/*).
 * Returns the Telegram message id as a string.
 */
export async function sendTelegramAttachment(
  bot: Bot,
  input: SendAttachmentInput,
): Promise<string> {
  const file = new InputFile(createReadStream(input.attachment.path), input.attachment.name);
  const chat = Number(input.chatId);
  const extra: Record<string, unknown> = {};
  if (input.caption) extra.caption = input.caption;
  if (input.threadId) extra.message_thread_id = Number(input.threadId);
  if (input.replyMarkup) extra.reply_markup = input.replyMarkup as object;

  const msg = input.attachment.mime.startsWith('image/')
    ? await bot.api.sendPhoto(chat, file, extra)
    : await bot.api.sendDocument(chat, file, extra);
  return String(msg.message_id);
}

/**
 * Resolve an inbound file_id via getFile, then fetch the bytes.
 */
export async function downloadTelegramFile(bot: Bot, fileId: string): Promise<Buffer> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error(`Telegram getFile: no file_path for ${fileId}`);
  const token = (bot as unknown as { token: string }).token;
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Telegram download ${res.status}: ${res.statusText}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}
