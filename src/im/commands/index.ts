// src/im/commands/index.ts
//
// Registers every command via static imports so the bundler keeps them.
// T9 bootstrap calls `registerAllCommands()` once at daemon start.

import { registerCommand } from '../command-parser.js';

// Session lifecycle
import { helpCmd } from './help.js';
import { newCmd } from './new.js';
import { stopCmd } from './stop.js';
import { killCmd } from './kill.js';
import { resumeCmd } from './resume.js';
import { sessionsCmd } from './sessions.js';
import { archiveCmd } from './archive.js';
import { forkCmd } from './fork.js';
import { renameCmd } from './rename.js';
import { takebackCmd } from './takeback.js';

// History / time
import { searchCmd } from './search.js';
import { exportCmd } from './export.js';
import { timeTravelCmd } from './time-travel.js';
import { rewindCmd } from './rewind.js';
import { costCmd } from './cost.js';
import { whoamiCmd } from './whoami.js';

// Runtime adjustment (mid-session)
import { modelCmd } from './model.js';
import { modeCmd } from './mode.js';
import { effortCmd } from './effort.js';
import { permCmd } from './perm.js';
import { thinkingCmd } from './thinking.js';
import { verboseCmd } from './verbose.js';
import { budgetCmd } from './budget.js';
import { prewarmCmd } from './prewarm.js';
import { cancelQueuedCmd } from './cancel-queued.js';
import { stopTaskCmd } from './stop-task.js';

// Introspection
import { statusCmd } from './status.js';
import { modelsCmd } from './models.js';
import { agentsCmd } from './agents.js';
import { pluginsCmd } from './plugins.js';
import { mcpCmd } from './mcp.js';

// Workspace / multi-chat
import { workspaceCmd } from './workspace.js';
import { pairingsCmd } from './pairings.js';
import { mirrorCmd } from './mirror.js';
import { bindCmd } from './bind.js';
import { grantCmd } from './grant.js';

// Handoff / companion
import { handoffToMeCmd } from './handoff-to-me.js';
import { companionCmd } from './companion.js';

// Agent / skill authoring
import { agentCmd } from './agent.js';
import { skillCmd } from './skill.js';

// Multi-user + attachments
import { revokeCmd } from './revoke.js';
import { attachLastCmd } from './attach-last.js';

// Advanced MCP
import { pipelineCmd } from './pipeline.js';
import { scheduleCmd } from './schedule.js';
import { handoffCmd } from './handoff.js';

export const ALL_COMMANDS = [
  helpCmd, newCmd, stopCmd, killCmd, resumeCmd, sessionsCmd, archiveCmd, forkCmd, renameCmd, takebackCmd,
  searchCmd, exportCmd, timeTravelCmd, rewindCmd, costCmd, whoamiCmd,
  modelCmd, modeCmd, effortCmd, permCmd, thinkingCmd, verboseCmd, budgetCmd, prewarmCmd, cancelQueuedCmd, stopTaskCmd,
  statusCmd, modelsCmd, agentsCmd, pluginsCmd, mcpCmd,
  workspaceCmd, pairingsCmd, mirrorCmd, bindCmd, grantCmd,
  handoffToMeCmd, companionCmd,
  agentCmd, skillCmd,
  revokeCmd, attachLastCmd,
  pipelineCmd, scheduleCmd, handoffCmd,
];

export function registerAllCommands(): void {
  for (const cmd of ALL_COMMANDS) registerCommand(cmd);
}
