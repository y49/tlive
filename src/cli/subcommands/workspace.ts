// src/cli/subcommands/workspace.ts
import { join } from 'node:path';
import { homedir } from 'node:os';
import { WorkspaceRegistry } from '../../kernel/workspace/registry.js';

export async function runWorkspace(argv: string[]): Promise<void> {
  const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
  const reg = new WorkspaceRegistry({ home });
  const sub = argv[0];
  if (sub === 'list') {
    for (const w of reg.list()) process.stdout.write(`${w.id}\t${w.path}\n`);
    return;
  }
  if (sub === 'add') {
    const path = argv[1] ?? process.cwd();
    const id = `ws-${path.split('/').filter(Boolean).pop() ?? 'default'}`;
    reg.add(id, path);
    process.stdout.write(`added: ${id} -> ${path}\n`);
    return;
  }
  if (sub === 'remove') {
    const id = argv[1];
    if (!id) { process.stderr.write('Usage: tlive workspace remove <id>\n'); process.exit(1); }
    reg.remove(id);
    process.stdout.write(`removed: ${id}\n`);
    return;
  }
  process.stderr.write('Usage: tlive workspace add|list|remove\n');
  process.exit(1);
}
