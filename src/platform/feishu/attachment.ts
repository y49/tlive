// src/platform/feishu/attachment.ts
//
// Upload/download helpers for Feishu messages. Files go through
// im/v1/files/upload_all (or images endpoint for image/*), then the returned
// `file_key` / `image_key` is referenced in a `file` / `image` message body.

import { createReadStream } from 'node:fs';
import type { OutboundAttachment } from '../types.js';

export interface FeishuUploadInput {
  client: unknown;
  chatId: string;
  attachment: OutboundAttachment;
}

/** Upload + send; returns the Feishu message_id. Treats images separately. */
export async function sendFeishuAttachment(input: FeishuUploadInput): Promise<string> {
  const client = input.client as {
    im: {
      v1: {
        file: { create: (args: unknown) => Promise<{ data?: { file_key?: string } }> };
        image: { create: (args: unknown) => Promise<{ data?: { image_key?: string } }> };
        message: { create: (args: unknown) => Promise<{ data?: { message_id?: string } }> };
      };
    };
  };
  const isImage = input.attachment.mime.startsWith('image/');
  let key: string;
  if (isImage) {
    const up = await client.im.v1.image.create({
      data: { image_type: 'message', image: createReadStream(input.attachment.path) },
    });
    key = up.data?.image_key ?? '';
  } else {
    const up = await client.im.v1.file.create({
      data: {
        file_type: guessFileType(input.attachment.mime),
        file_name: input.attachment.name,
        file: createReadStream(input.attachment.path),
      },
    });
    key = up.data?.file_key ?? '';
  }

  const content = isImage
    ? JSON.stringify({ image_key: key })
    : JSON.stringify({ file_key: key });
  const sent = await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: input.chatId,
      msg_type: isImage ? 'image' : 'file',
      content,
    },
  });
  return sent.data?.message_id ?? '';
}

export async function downloadFeishuAttachment(client: unknown, fileKey: string): Promise<Buffer> {
  const c = client as {
    im: { v1: { file: { get?: (args: unknown) => Promise<NodeJS.ReadableStream | Buffer> } } };
  };
  const fn = c.im?.v1?.file?.get;
  if (!fn) throw new Error('Feishu SDK: im.v1.file.get unavailable');
  const stream = await fn({ path: { file_key: fileKey } });
  if (Buffer.isBuffer(stream)) return stream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream as NodeJS.ReadableStream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function guessFileType(mime: string): string {
  if (mime.startsWith('audio/')) return 'opus';
  if (mime.startsWith('video/')) return 'mp4';
  return 'stream';
}
