// src/cli/logs.ts — read-only tail of ~/.tlive/sessions/<id>.jsonl
import { createReadStream, existsSync, watchFile } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';

export async function logsCommand(sessionId: string | undefined, opts: { follow?: boolean } = {}): Promise<void> {
  if (!sessionId) { process.stderr.write('usage: tlive logs [--follow] <session-id>\n'); process.exit(2); }
  const path = join(homedir(), '.tlive', 'sessions', `${sessionId}.jsonl`);
  if (!existsSync(path)) { process.stderr.write(`no history for ${sessionId}\n`); process.exit(1); }
  await streamFile(path);
  if (opts.follow) {
    let lastSize = 0;
    watchFile(path, { interval: 500 }, async (curr) => {
      if (curr.size < lastSize) lastSize = 0;
      if (curr.size > lastSize) {
        await streamFile(path, lastSize);
        lastSize = curr.size;
      }
    });
    await new Promise(() => {});
  }
}

async function streamFile(path: string, start = 0): Promise<void> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf-8', start }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line) as { kind: string };
      process.stdout.write(`[${evt.kind}] ${JSON.stringify(evt).slice(0, 200)}\n`);
    } catch { /* skip */ }
  }
}

if (process.argv[1]?.endsWith('tlive-logs.mjs')) {
  const args = process.argv.slice(2);
  const follow = args.includes('--follow') || args.includes('-f');
  const id = args.filter((a) => !a.startsWith('-'))[0];
  await logsCommand(id, { follow });
}
