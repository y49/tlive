// src/attachment/ingester.ts
//
// Converts inbound IM attachments (image/text/binary) into a form the agent
// SDK can consume. Routing rules:
//   - `image/*`  → base64 content block: `{ type: 'image', source: { type:
//                  'base64', media_type, data } }`
//   - `text/*`   small (<50 KB) → inline text block: `{ type: 'text', text }`
//   - everything else / large → file dropped into `<workdir>/tlive-uploads/`
//                  and returned as a text block referencing its path
//
// The ingester does NOT talk to AttachmentStore directly — the caller (T6
// platform adapter) registers first, then passes (attachment, data) to
// `toContentBlock`. This keeps responsibilities crisp: Store is pure
// ground-truth; Ingester is pure format routing.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Attachment } from './store.js';

const INLINE_TEXT_LIMIT = 50_000; // bytes

export type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    };

export interface IngestResult {
  block: ContentBlock;
  /** When the binary-path branch fires, the absolute write location; else null. */
  writtenPath: string | null;
}

export interface IngestOptions {
  /** Agent working directory — binary attachments are dropped here. */
  workdir: string;
}

/**
 * Translate a registered Attachment + its raw bytes into an agent content
 * block. On the "write to workdir" path, the file lands under
 * `<workdir>/tlive-uploads/<timestamp>-<name>` and the returned block tells
 * the agent where to find it.
 */
export async function ingest(
  attachment: Attachment,
  data: Buffer,
  opts: IngestOptions,
): Promise<IngestResult> {
  const mime = attachment.mime || 'application/octet-stream';

  if (mime.startsWith('image/')) {
    return {
      block: {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mime,
          data: data.toString('base64'),
        },
      },
      writtenPath: null,
    };
  }

  if (mime.startsWith('text/') && data.length < INLINE_TEXT_LIMIT) {
    return {
      block: { type: 'text', text: data.toString('utf8') },
      writtenPath: null,
    };
  }

  // Binary / large text → drop into workdir and reference by path.
  const uploadsDir = join(opts.workdir, 'tlive-uploads');
  await fs.mkdir(uploadsDir, { recursive: true });
  const safeName = attachment.name.replace(/[/\\:\0]/g, '_').slice(0, 200) || 'upload';
  const dest = join(uploadsDir, `${Date.now()}-${safeName}`);
  await fs.writeFile(dest, data);
  return {
    block: { type: 'text', text: `File placed at ./tlive-uploads/${safeName}` },
    writtenPath: dest,
  };
}
