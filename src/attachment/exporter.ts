// src/attachment/exporter.ts
//
// Watches runtime `file_changed` events with op='created' and produces a
// platform-neutral OutboundAttachment shape the T6 adapters can upload.
// T4 scope: just the transform and a small helper. Wiring into the
// NotificationEvent stream is T6's job.

import { basename, extname } from 'node:path';
import type { NotificationEvent } from '../runtime/events.js';

export interface OutboundAttachment {
  /** Absolute path to read bytes from. */
  path: string;
  /** Suggested file name shown in the IM UI. */
  name: string;
  /** Best-effort MIME guess — adapters may override. */
  mime: string;
  sessionId: string;
}

/**
 * Transform a runtime-level `file_changed` event (op=created) into the
 * platform-neutral outbound shape. Returns null for non-create ops or
 * unusable paths so callers can filter the event stream cheaply.
 */
export function toPlatformAttachment(
  event: NotificationEvent,
  sessionId: string,
): OutboundAttachment | null {
  if (event.kind !== 'file_changed') return null;
  if (event.op !== 'created') return null;
  if (!event.path) return null;
  const name = basename(event.path);
  return {
    path: event.path,
    name,
    mime: guessMime(name),
    sessionId,
  };
}

/** Tiny MIME heuristic — adapters may consult a fuller db but this covers
 *  the common cases (images + text docs). */
function guessMime(name: string): string {
  const ext = extname(name).toLowerCase();
  switch (ext) {
    case '.png':  return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif':  return 'image/gif';
    case '.webp': return 'image/webp';
    case '.svg':  return 'image/svg+xml';
    case '.pdf':  return 'application/pdf';
    case '.md':
    case '.txt':  return 'text/plain';
    case '.json': return 'application/json';
    case '.html': return 'text/html';
    case '.csv':  return 'text/csv';
    default:      return 'application/octet-stream';
  }
}
