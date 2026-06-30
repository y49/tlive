import { describe, it, expect } from 'vitest';
import {
  FrameType, encodeData, encodeResize, encodeAttach, encodeDetach,
  encodeSnapshotReply, encodeSize, FrameDecoder, parseDims,
} from '../stream-protocol';

describe('stream-protocol frame codec', () => {
  it('round-trips a data frame with raw bytes (incl. nulls/high bytes)', () => {
    const raw = Buffer.from([0x00, 0x1b, 0x5b, 0xff, 0x0a]);
    const frames = new FrameDecoder().push(encodeData(raw));
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(FrameType.Data);
    expect(frames[0].payload.equals(raw)).toBe(true);
  });

  it('round-trips resize/attach dims', () => {
    const dec = new FrameDecoder();
    const r = dec.push(encodeResize(120, 40))[0];
    expect(r.type).toBe(FrameType.Resize);
    expect(parseDims(r.payload)).toEqual({ cols: 120, rows: 40 });
    const a = dec.push(encodeAttach(80, 24))[0];
    expect(a.type).toBe(FrameType.Attach);
    expect(parseDims(a.payload)).toEqual({ cols: 80, rows: 24 });
  });

  it('round-trips detach (empty payload) and snapshot reply', () => {
    const dec = new FrameDecoder();
    const d = dec.push(encodeDetach())[0];
    expect(d.type).toBe(FrameType.Detach);
    expect(d.payload).toHaveLength(0);
    const s = dec.push(encodeSnapshotReply('hello\nworld'))[0];
    expect(s.type).toBe(FrameType.SnapshotReply);
    expect(s.payload.toString('utf8')).toBe('hello\nworld');
  });

  it('decodes multiple frames delivered in one chunk', () => {
    const buf = Buffer.concat([encodeData(Buffer.from('ab')), encodeResize(10, 5), encodeDetach()]);
    const frames = new FrameDecoder().push(buf);
    expect(frames.map((f) => f.type)).toEqual([FrameType.Data, FrameType.Resize, FrameType.Detach]);
  });

  it('reassembles a frame split across two chunks', () => {
    const whole = encodeData(Buffer.from('split-me'));
    const dec = new FrameDecoder();
    expect(dec.push(whole.subarray(0, 3))).toHaveLength(0); // header incomplete
    const out = dec.push(whole.subarray(3));
    expect(out).toHaveLength(1);
    expect(out[0].payload.toString()).toBe('split-me');
  });

  it('round-trips a server→client Size frame', () => {
    const f = new FrameDecoder().push(encodeSize(120, 40))[0];
    expect(f.type).toBe(FrameType.Size);
    expect(parseDims(f.payload)).toEqual({ cols: 120, rows: 40 });
  });
});
