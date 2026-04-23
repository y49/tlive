// src/attachment/store.ts
//
// AttachmentStore — central registry for inbound (IM → agent) and outbound
// (agent → IM) file attachments. Files are copied under
// `~/.tlive/attachments/<direction>/<sessionId>/<timestamp>-<name>` so we
// have a stable ground-truth regardless of where the IM adapter stashed
// them. In-memory `index` maps id → metadata for quick lookup from the IPC
// / MCP surfaces.
//
// Spec: docs/superpowers/specs/2026-04-22-t14b-full-cutover-design.md §7.3.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export type AttachmentDirection = 'inbound' | 'outbound';

export interface Attachment {
  id: string;
  sessionId: string;
  name: string;
  mime: string;
  sizeBytes: number;
  /** Absolute on-disk location after registration. */
  path: string;
  createdAt: string;
  direction: AttachmentDirection;
}

export interface AttachmentStoreOptions {
  /** Override default `~/.tlive/attachments`. Tests pass a temp dir. */
  rootDir?: string;
}

export class AttachmentStore {
  private readonly index = new Map<string, Attachment>();
  private readonly dir: string;

  constructor(opts: AttachmentStoreOptions = {}) {
    this.dir = opts.rootDir ?? join(homedir(), '.tlive', 'attachments');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  /**
   * Copy `data` into the store and return the populated Attachment record.
   * `name` is preserved (prefixed with a timestamp for uniqueness); the
   * returned `path` is the absolute on-disk location callers can re-read.
   */
  async register(
    sessionId: string,
    name: string,
    mime: string,
    data: Buffer,
    direction: AttachmentDirection,
  ): Promise<Attachment> {
    const id = randomBytes(6).toString('hex');
    const sub = join(this.dir, direction, sessionId);
    await fs.mkdir(sub, { recursive: true });
    const safeName = sanitizeName(name);
    // Embed the attachment id in the filename so two inbound uploads with
    // the same name within the same millisecond still get distinct paths.
    const path = join(sub, `${Date.now()}-${id}-${safeName}`);
    await fs.writeFile(path, data);
    const attachment: Attachment = {
      id,
      sessionId,
      name,
      mime,
      sizeBytes: data.length,
      path,
      createdAt: new Date().toISOString(),
      direction,
    };
    this.index.set(id, attachment);
    return attachment;
  }

  get(id: string): Attachment | undefined {
    return this.index.get(id);
  }

  listForSession(sessionId: string): Attachment[] {
    return [...this.index.values()].filter((a) => a.sessionId === sessionId);
  }

  /** Total registered attachments. Used by tests + metrics. */
  size(): number {
    return this.index.size;
  }
}

/** Strip path separators + control chars so a malicious IM filename can't
 *  escape the per-session directory. */
function sanitizeName(name: string): string {
  return name.replace(/[/\\:\0]/g, '_').slice(0, 200) || 'attachment';
}
