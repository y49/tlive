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
      expect(result.block.text).toBe('File placed at ./tlive-uploads/big.txt');
    }
    expect(result.writtenPath).not.toBeNull();
    const onDisk = await readFile(result.writtenPath!);
    expect(onDisk.length).toBe(data.length);
  });

  it('binary data writes to <workdir>/tlive-uploads/', async () => {
    const data = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const att = makeAttachment({ name: 'blob.bin', mime: 'application/octet-stream' });
    const result = await ingest(att, data, { workdir });
    expect(result.block).toMatchObject({
      type: 'text',
      text: 'File placed at ./tlive-uploads/blob.bin',
    });
    expect(result.writtenPath).toContain(join(workdir, 'tlive-uploads'));
    const files = await readdir(join(workdir, 'tlive-uploads'));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('blob.bin');
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
