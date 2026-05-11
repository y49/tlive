// src/cli/subcommands/approve.ts
import { request } from '../../kernel/ipc/client.js';

export async function runApprove(argv: string[]): Promise<void> {
  const requestId = argv[0];
  const decision = argv[1];
  if (!requestId || !decision || (decision !== 'yes' && decision !== 'no')) {
    process.stderr.write('Usage: tlive approve <requestId> <yes|no>\n');
    process.exit(1);
  }
  await request({ kind: 'mcp.permission.answer', requestId, approved: decision === 'yes' });
  process.stdout.write(`tlive approve: ${decision}\n`);
}
