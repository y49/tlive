// src/im/commands/index.ts
//
// Registers the 12 v3.3 IM slash commands. See spec
// docs/superpowers/specs/2026-04-30-im-commands-redesign-design.md §3.

import { registerCommand } from '../command-parser.js';

// Workspace-scoped (history / resources)
import { newCmd } from './new.js';
import { sessionsCmd } from './sessions.js';
import { workspaceCmd } from './workspace.js';
import { costCmd } from './cost.js';
import { findCmd } from './find.js';

// Session-scoped (runtime / interrupt)
import { stopCmd } from './stop.js';
import { modelCmd } from './model.js';
import { modeCmd } from './mode.js';
import { thinkCmd } from './think.js';
import { permCmd } from './perm.js';
import { budgetCmd } from './budget.js';

// Meta
import { helpCmd } from './help.js';

export const ALL_COMMANDS = [
  newCmd, sessionsCmd, workspaceCmd, costCmd, findCmd,
  stopCmd, modelCmd, modeCmd, thinkCmd, permCmd, budgetCmd,
  helpCmd,
];

export function registerAllCommands(): void {
  for (const cmd of ALL_COMMANDS) registerCommand(cmd);
}
