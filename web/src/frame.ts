// web/src/frame.ts
//
// Browser-side codec for the per-session stream-protocol. Uint8Array/DataView only
// (no node Buffer), wire-compatible with src/kernel/web/stream-protocol.ts.

import { FrameType } from '../../src/kernel/web/frame-types.js';
export { FrameType };

export interface Frame { type: number; payload: Uint8Array }

const HEADER = 5;

function encodeFrame(type: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(HEADER + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, type);
  dv.setUint32(1, payload.length, false); // big-endian
  out.set(payload, HEADER);
  return out;
}

export function encodeData(data: Uint8Array): Uint8Array { return encodeFrame(FrameType.Data, data); }
function encodeDims(t: number, cols: number, rows: number): Uint8Array {
  return encodeFrame(t, new TextEncoder().encode(JSON.stringify({ cols, rows })));
}
export function encodeAttach(cols: number, rows: number): Uint8Array { return encodeDims(FrameType.Attach, cols, rows); }
export function encodeResize(cols: number, rows: number): Uint8Array { return encodeDims(FrameType.Resize, cols, rows); }

export class FrameDecoder {
  private buf = new Uint8Array(0);
  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf); merged.set(chunk, this.buf.length);
    this.buf = merged;
    const frames: Frame[] = [];
    while (this.buf.length >= HEADER) {
      const dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.length);
      const len = dv.getUint32(1, false);
      if (this.buf.length < HEADER + len) break;
      frames.push({ type: this.buf[0], payload: this.buf.slice(HEADER, HEADER + len) });
      this.buf = this.buf.slice(HEADER + len);
    }
    return frames;
  }
}
