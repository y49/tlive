// tests/attachment/ingester.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingest } from '../../src/attachment/ingester.js';
import type { Attachment } from '../../src/attachment/store.js';

function makeAttachment(overrides: Partial<Attachment>): Attachment {
  return {
    id: 'id-1',
    sessionId: 's1',
    name: 'file',
    mime: 'application/octet-stream',
    sizeBytes: 0,
    path: '/dev/null',
    createdAt: new Date().toISOString(),
    direction: 'inbound',
    ...overrides,
  };
}

describe('ingest', () => {
  let workdir: string;
  beforeEach(async () => { workdir = await mkdtemp(join(tmpdir(), 'tlive-ing-')); });
  afterEach(async () => { await rm(workdir, { recursive: true, force: true }); });

  it('image/png → base64 image block', async () => {
    const data = Buffer.from([137, 80, 78, 71]); // PNG magic bytes
    const att = makeAttachment({ name: 'pic.png', mime: 'image/png' });
    const result = await ingest(att, data, { workdir });
    expect(result.block).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    });
    expect(result.writtenPath).toBeNull();
    if (result.block.type === 'image') {
      expect(result.block.source.data).toBe(data.toString('base64'));
    }
  });

  it('image/jpeg → base64 image block with correct media_type', async () => {
    const data = Buffer.from([0xff, 0xd8, 0xff]);
    const att = makeAttachment({ name: 'pic.jpg', mime: 'image/jpeg' });
    const result = await ingest(att, data, { workdir });
    if (result.block.type === 'image') {
      expect(result.block.source.media_type).toBe('image/jpeg');
    } else {
      throw new Error('expected image block');
    }
  });

  it('small text → inline text block', async () => {
    const data = Buffer.from('hello world');
    const att = makeAttachment({ name: 'note.txt', mime: 'text/plain' });
    const result = await ingest(att, data, { workdir });
    expect(result.block).toEqual({ type: 'text', text: 'hello world' });
    expect(result.writtenPath).toBeNull();
  });

  it('large text (>50KB) falls through to workdir write', async () => {
    const data = Buffer.alloc(51_000, 0x41); // 51KB of 'A'
    const att = makeAttachment({ name: 'big.txt', mime: 'text/plain' });
    const result = await ingest(att, data, { workdir });
    expect(result.block.type).toBe('text');
    if (result.block.type === 'text') {
      // Text block must carry the timestamp-prefixed on-disk filename so
      // the agent reads the actual file (not the bare safeName).
      expect(result.block.text).toMatch(/^File placed at \.\/tlive-uploads\/\d+-big\.txt$/);
    }
    expect(result.writtenPath).not.toBeNull();
    const onDisk = await readFile(result.writtenPath!);
    expect(onDisk.length).toBe(data.length);
  });

  it('binary data writes to <workdir>/tlive-uploads/', async () => {
    const data = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const att = makeAttachment({ name: 'blob.bin', mime: 'application/octet-stream' });
    const result = await ingest(att, data, { workdir });
    expect(result.block.type).toBe('text');
    if (result.block.type === 'text') {
      expect(result.block.text).toMatch(/^File placed at \.\/tlive-uploads\/\d+-blob\.bin$/);
    }
    expect(result.writtenPath).toContain(join(workdir, 'tlive-uploads'));
    const files = await readdir(join(workdir, 'tlive-uploads'));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('blob.bin');
  });

  it('concurrent same-name binary uploads produce distinct paths AND matching text blocks', async () => {
    const att1 = makeAttachment({ name: 'dup.bin', mime: 'application/octet-stream' });
    const att2 = makeAttachment({ name: 'dup.bin', mime: 'application/octet-stream' });
    const r1 = await ingest(att1, Buffer.from('first'), { workdir });
    // Make sure the millisecond clock can advance so timestamps differ; even
    // in the theoretical same-millisecond case the agent-facing text still
    // matches whatever was written, which is the invariant this test pins.
    await new Promise((r) => setTimeout(r, 2));
    const r2 = await ingest(att2, Buffer.from('second'), { workdir });

    expect(r1.writtenPath).not.toBeNull();
    expect(r2.writtenPath).not.toBeNull();
    expect(r1.writtenPath).not.toBe(r2.writtenPath);

    // Both files must exist on disk with their respective bytes.
    expect((await readFile(r1.writtenPath!)).toString()).toBe('first');
    expect((await readFile(r2.writtenPath!)).toString()).toBe('second');

    // Each returned text block must reference the actual filename that lives
    // at writtenPath — NOT a bare safeName that would shadow both files.
    const name1 = r1.writtenPath!.split('/').pop()!;
    const name2 = r2.writtenPath!.split('/').pop()!;
    if (r1.block.type === 'text') {
      expect(r1.block.text).toBe(`File placed at ./tlive-uploads/${name1}`);
    } else { throw new Error('expected text block'); }
    if (r2.block.type === 'text') {
      expect(r2.block.text).toBe(`File placed at ./tlive-uploads/${name2}`);
    } else { throw new Error('expected text block'); }

    const files = await readdir(join(workdir, 'tlive-uploads'));
    expect(files).toHaveLength(2);
  });

  it('missing mime defaults to binary path', async () => {
    const data = Buffer.from('anything');
    const att = makeAttachment({ name: 'unknown', mime: '' });
    const result = await ingest(att, data, { workdir });
    expect(result.writtenPath).not.toBeNull();
  });

  it('sanitizes filename with path separators before writing', async () => {
    const data = Buffer.from('x');
    const att = makeAttachment({ name: '../bad.bin', mime: 'application/octet-stream' });
    const result = await ingest(att, data, { workdir });
    // Written path must stay inside <workdir>/tlive-uploads/.
    expect(result.writtenPath!.startsWith(join(workdir, 'tlive-uploads'))).toBe(true);
  });
});
