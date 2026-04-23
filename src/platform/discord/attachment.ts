// src/platform/discord/attachment.ts
//
// Discord send/download helpers. discord.js accepts Buffer / Stream in
// MessageCreateOptions.files; downloads just use fetch on the CDN URL.

import { AttachmentBuilder, type Message, type TextBasedChannel } from 'discord.js';
import { createReadStream } from 'node:fs';
import type { OutboundAttachment } from '../types.js';

export interface DiscordSendAttachmentInput {
  channel: TextBasedChannel & { send: (options: unknown) => Promise<Message> };
  attachment: OutboundAttachment;
  caption?: string;
  components?: unknown[];
}

export async function sendDiscordAttachment(input: DiscordSendAttachmentInput): Promise<string> {
  const file = new AttachmentBuilder(createReadStream(input.attachment.path), {
    name: input.attachment.name,
  });
  const msg = await input.channel.send({
    content: input.caption ?? '',
    files: [file],
    components: input.components,
  });
  return msg.id;
}

export async function downloadDiscordAttachment(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Discord download ${res.status}: ${res.statusText}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}
