// src/cli/install-integrations.ts
//
// `tlive install-integrations [claude|codex|all]`
//
// Copies bundled skill / prompt templates into the user's Claude / Codex
// configuration directories and patches the matching MCP entry. When no
// argument is supplied we run a small interactive wizard (Full / Companion
// / Both / Skip) so first-time users can pick a mode.
//
// The heavy lifting lives in `src/skills/installer.ts`; this file is the
// thin CLI wrapper dispatched by `scripts/cli.js` / `dist/src/tlive-install-
// integrations.mjs`.

import { createInterface } from 'node:readline';
import { installClaude, installCodex, installAll } from '../skills/installer.js';

type Mode = 'full' | 'companion' | 'both' | 'claude' | 'codex' | 'all' | 'skip';

function usage(): void {
  process.stdout.write([
    'Usage: tlive install-integrations [claude|codex|all]',
    '',
    'Copies bundled skill / prompt templates and patches MCP settings.',
    '',
    '  claude     Claude Code — SKILL.md + /tlive command + scripts + settings.json',
    '  codex      Codex — /prompts tlive + config.toml',
    '  all        Both Claude and Codex (default when invoked interactively)',
    '',
    'With no argument the command runs an interactive wizard that offers',
    'Full (Daemon + Companion), Companion-only, Both, or Skip.',
    '',
  ].join('\n'));
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (ans) => resolve(ans.trim()));
    });
  } finally {
    rl.close();
  }
}

async function runWizard(): Promise<Mode> {
  process.stdout.write([
    'tlive install-integrations — pick a mode:',
    '',
    '  1) Full       daemon-driven (Mode A) — Claude skill + Codex prompt',
    '  2) Companion  local CLI + MCP (Mode B) — Claude skill patches MCP only',
    '  3) Both       Full + Companion',
    '  4) Skip       exit without writing',
    '',
  ].join('\n'));
  const answer = await prompt('Selection [1-4] (default 3): ');
  switch (answer) {
    case '1': return 'full';
    case '2': return 'companion';
    case '':
    case '3': return 'both';
    case '4': return 'skip';
    default:  return 'skip';
  }
}

async function run(mode: Mode): Promise<void> {
  const log = (line: string): void => { process.stdout.write(`${line}\n`); };
  switch (mode) {
    case 'claude': {
      const r = await installClaude({ log });
      process.stdout.write(`\nClaude integration installed to ${r.destRoot}.\n`);
      return;
    }
    case 'codex': {
      const r = await installCodex({ log });
      process.stdout.write(`\nCodex integration installed to ${r.destRoot}.\n`);
      return;
    }
    case 'all':
    case 'both':
    case 'full': {
      const r = await installAll({ log });
      process.stdout.write(
        `\nClaude: ${r.claude.destRoot}\nCodex:  ${r.codex.destRoot}\n`,
      );
      return;
    }
    case 'companion': {
      // Companion-mode: Claude receives the MCP entry; Codex prompt is
      // optional since local Codex can hit the same MCP directly.
      const r = await installClaude({ log });
      process.stdout.write(`\nClaude companion integration installed to ${r.destRoot}.\n`);
      process.stdout.write(
        'Tip: set "permissionPromptToolName": "mcp__tlive__approve" in ' +
        `${r.configPatched ?? r.destRoot + '/settings.json'} to route local ` +
        'Claude permissions through tlive IM.\n',
      );
      return;
    }
    case 'skip': {
      process.stdout.write('No changes made.\n');
      return;
    }
  }
}

export async function installIntegrationsCommand(argv: string[]): Promise<void> {
  const arg = argv[0]?.toLowerCase();
  if (arg === '-h' || arg === '--help') { usage(); return; }
  const mode: Mode = (arg === 'claude' || arg === 'codex' || arg === 'all')
    ? arg
    : arg === undefined
      ? await runWizard()
      : (() => { usage(); process.exit(2); })();
  await run(mode);
}

if (process.argv[1]?.endsWith('tlive-install-integrations.mjs')) {
  installIntegrationsCommand(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`tlive install-integrations failed: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
