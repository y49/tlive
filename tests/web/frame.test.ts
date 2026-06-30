import { describe, it, expect } from 'vitest';
import { FrameType, encodeData, encodeAttach, parseDims, FrameDecoder } from '../../web/src/frame';
import { encodeData as nodeEncodeData, encodeSize as nodeEncodeSize } from '../../src/kernel/web/stream-protocol';

const dec = (chunks: Uint8Array[]) => {
  const d = new FrameDecoder();
  return chunks.flatMap((c) => d.push(c));
};

describe('browser frame codec', () => {
  it('round-trips a data frame (Uint8Array, binary-safe)', () => {
    const raw = new Uint8Array([0x00, 0x1b, 0xff, 0x0a]);
    const out = dec([encodeData(raw)]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe(FrameType.Data);
    expect([...out[0].payload]).toEqual([...raw]);
  });
  it('encodes attach dims as JSON', () => {
    const out = dec([encodeAttach(120, 40)]);
    expect(out[0].type).toBe(FrameType.Attach);
    expect(JSON.parse(new TextDecoder().decode(out[0].payload))).toEqual({ cols: 120, rows: 40 });
  });
  it('reassembles a frame split across chunks', () => {
    const whole = encodeData(new TextEncoder().encode('split'));
    const out = dec([whole.slice(0, 3), whole.slice(3)]);
    expect(out).toHaveLength(1);
    expect(new TextDecoder().decode(out[0].payload)).toBe('split');
  });
  it('is wire-compatible with the Node codec (decodes a Node-encoded data frame)', () => {
    const nodeFrame = nodeEncodeData(Buffer.from('héllo'));
    const out = dec([new Uint8Array(nodeFrame)]);
    expect(out[0].type).toBe(FrameType.Data);
    expect(new TextDecoder().decode(out[0].payload)).toBe('héllo');
  });
  it('parseDims reads a Node-encoded Size frame (wire-compatible)', () => {
    const out = dec([new Uint8Array(nodeEncodeSize(120, 40))]);
    expect(out[0].type).toBe(FrameType.Size);
    expect(parseDims(out[0].payload)).toEqual({ cols: 120, rows: 40 });
  });
});
