// src/cli/subcommands/handoff.ts
//
// v2.0: 'handoff' is a no-op stub.
// In v2 the daemon does NOT own sessions; hooks fire automatically from
// the user's own interactive claude session. There is no daemon-side
// "take ownership" step.

export async function runHandoff(_argv: string[]): Promise<void> {
  process.stdout.write(
    'tlive handoff: this command is not needed in v2.0.\n' +
    'tlive v2 uses hooks — Claude fires them automatically when you run claude in a workspace directory.\n' +
    'Run `tlive install-integrations` to write the hook entries into ~/.claude/settings.json.\n',
  );
}
