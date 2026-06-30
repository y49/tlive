//
// Per-session pty stream framing. Wire format per frame:
//   [1 byte type][4 byte uint32 BE payload length][payload bytes]
// `data` payloads are raw pty bytes (binary-safe); control payloads are UTF-8 JSON.
// Shared by SessionHost (server side) and PtyBridge (daemon client side).

import { FrameType } from './frame-types.js';
export { FrameType };

export interface Frame {
  type: FrameType;
  payload: Buffer;
}

const HEADER = 5;

export function encodeFrame(type: FrameType, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.allocUnsafe(HEADER);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export function encodeData(data: Buffer): Buffer {
  return encodeFrame(FrameType.Data, data);
}
function encodeDims(type: FrameType, cols: number, rows: number): Buffer {
  return encodeFrame(type, Buffer.from(JSON.stringify({ cols, rows }), 'utf8'));
}
export function encodeResize(cols: number, rows: number): Buffer {
  return encodeDims(FrameType.Resize, cols, rows);
}
export function encodeAttach(cols: number, rows: number): Buffer {
  return encodeDims(FrameType.Attach, cols, rows);
}
export function encodeSize(cols: number, rows: number): Buffer {
  return encodeDims(FrameType.Size, cols, rows);
}
export function encodeDetach(): Buffer {
  return encodeFrame(FrameType.Detach);
}
export function encodeSnapshotRequest(): Buffer {
  return encodeFrame(FrameType.SnapshotRequest);
}
export function encodeSnapshotReply(screen: string): Buffer {
  return encodeFrame(FrameType.SnapshotReply, Buffer.from(screen, 'utf8'));
}

export function parseDims(payload: Buffer): { cols: number; rows: number } {
  const o = JSON.parse(payload.toString('utf8')) as { cols: number; rows: number };
  return { cols: Number(o.cols), rows: Number(o.rows) };
}

export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Frame[] = [];
    while (this.buf.length >= HEADER) {
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < HEADER + len) break;
      const type = this.buf.readUInt8(0) as FrameType;
      const payload = Buffer.from(this.buf.subarray(HEADER, HEADER + len));
      frames.push({ type, payload });
      this.buf = this.buf.subarray(HEADER + len);
    }
    return frames;
  }
}
