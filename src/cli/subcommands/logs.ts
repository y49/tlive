// src/cli/subcommands/logs.ts
import { createReadStream, statSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { watch } from 'node:fs';

export async function runLogs(argv: string[]): Promise<void> {
  const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
  const logPath = join(home, 'daemon.log');
  if (!existsSync(logPath)) {
    process.stderr.write(`tlive logs: no log file at ${logPath}\n`);
    process.exit(1);
  }
  const follow = argv.includes('--follow') || argv.includes('-f');
  const lineArg = argv.find((a) => /^\d+$/.test(a));
  const tailLines = lineArg ? Number(lineArg) : 50;

  // Print last N lines
  await printTail(logPath, tailLines);

  if (!follow) return;

  // Watch for new content
  let lastSize = statSync(logPath).size;
  const watcher = watch(logPath, () => {
    const newSize = statSync(logPath).size;
    if (newSize > lastSize) {
      const stream = createReadStream(logPath, { start: lastSize, end: newSize });
      stream.pipe(process.stdout);
      lastSize = newSize;
    }
  });
  // run forever until Ctrl-C
  await new Promise<void>(() => { void watcher; });
}

async function printTail(path: string, n: number): Promise<void> {
  const lines: string[] = [];
  const stream = createReadStream(path, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream });
  for await (const line of rl) {
    lines.push(line);
    if (lines.length > n) lines.shift();
  }
  process.stdout.write(lines.join('\n') + (lines.length > 0 ? '\n' : ''));
}
