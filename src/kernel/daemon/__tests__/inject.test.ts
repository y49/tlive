import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionHost } from '../../pty/session-host.js';
import { bracketedPaste, injectInput } from '../inject.js';

describe('bracketedPaste', () => {
  it('wraps text in paste markers and appends Enter', () => {
    const b = bracketedPaste('hi 你好').toString('utf8');
    expect(b.startsWith('\x1b[200~')).toBe(true);
    expect(b.endsWith('\x1b[201~\r')).toBe(true);
    expect(b).toContain('hi 你好');
  });
});

describe('injectInput', () => {
  it('delivers text into the pty via the per-session socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-inj-'));
    const sockPath = join(dir, 's.sock');
    // echo stdin back to stdout so we can observe delivery
    const host = new SessionHost({
      id: 'i1', cmd: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'],
      cwd: dir, sockPath, attachLocal: false,
    });
    await host.start();
    let seen = '';
    const done = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no echo: ${JSON.stringify(seen)}`)), 8000);
      // observe pty output through a second socket client
      // (attach so we receive Data broadcasts)
      import('node:net').then(({ createConnection }) => {
        import('../../web/stream-protocol.js').then(({ FrameDecoder, FrameType, encodeAttach }) => {
          const dec = new FrameDecoder();
          const sock = createConnection(sockPath, () => sock.write(encodeAttach(80, 24)));
          sock.on('data', (chunk: Buffer) => {
            for (const f of dec.push(chunk)) {
              if (f.type === FrameType.Data) {
                seen += f.payload.toString('utf8');
                if (seen.includes('INJECTED-TEXT')) { clearTimeout(t); sock.end(); resolve(); }
              }
            }
          });
          sock.on('error', reject);
        });
      });
    });
    await injectInput(sockPath, 'INJECTED-TEXT');
    await done;
    await host.stop();
  });

  it('rejects when the socket is gone', async () => {
    await expect(injectInput(join(tmpdir(), 'nope-xyz.sock'), 'x', 500)).rejects.toThrow();
  });
});
