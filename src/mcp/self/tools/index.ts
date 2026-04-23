// src/mcp/self/tools/index.ts
//
// Tool registry. Each factory takes the shared Deps and returns a fully
// wired McpTool. The server spreads these into tools/list + tools/call
// handlers.

import type { McpTool, McpToolDeps } from '../deps.js';
import { makeApproveTool } from './approve.js';
import { makeAskRemoteTool } from './ask.js';
import { makeAwaitSignalTool, makeAwaitUserInputTool } from './await-signal.js';
import { makeNotifyImTool, makeNotifyLeaveTool } from './notify.js';
import { makeSyncStateTool } from './sync.js';
import {
  makeSessionsListTool, makeSessionsSearchTool, makeSessionsGetTool,
  makeSessionsSummaryTool, makeSessionsExecuteTool, makeSessionsOrchestrateTool,
} from './sessions.js';
import { makeMemoryGetTool, makeMemorySetTool, makeMemoryListTool } from './memory.js';
import { makeArtifactUploadTool, makeArtifactListTool } from './artifact.js';
import { makeHandoffReleaseTool, makeHandoffTakeTool } from './handoff.js';
import { makeWorkspaceInfoTool } from './workspace.js';
import { makeUserCurrentTool } from './user.js';
import {
  makePolicySuggestTool, makePolicyAddTool, makePolicyListTool, makePolicyRemoveTool,
} from './policy.js';
import {
  makeScheduleCreateTool, makeScheduleListTool, makeScheduleRemoveTool,
} from './schedule.js';

export function buildToolRegistry(deps: McpToolDeps): McpTool[] {
  return [
    makeApproveTool(deps),
    makeAskRemoteTool(deps),
    makeAwaitSignalTool(deps),
    makeAwaitUserInputTool(deps),
    makeNotifyImTool(deps),
    makeNotifyLeaveTool(deps),
    makeSyncStateTool(deps),
    makeSessionsListTool(deps),
    makeSessionsSearchTool(deps),
    makeSessionsGetTool(deps),
    makeSessionsSummaryTool(deps),
    makeSessionsExecuteTool(deps),
    makeSessionsOrchestrateTool(deps),
    makeMemoryGetTool(deps),
    makeMemorySetTool(deps),
    makeMemoryListTool(deps),
    makeArtifactUploadTool(deps),
    makeArtifactListTool(deps),
    makeHandoffReleaseTool(deps),
    makeHandoffTakeTool(deps),
    makeWorkspaceInfoTool(deps),
    makeUserCurrentTool(deps),
    makePolicySuggestTool(deps),
    makePolicyAddTool(deps),
    makePolicyListTool(deps),
    makePolicyRemoveTool(deps),
    makeScheduleCreateTool(deps),
    makeScheduleListTool(deps),
    makeScheduleRemoveTool(deps),
  ];
}

export function indexByName(tools: McpTool[]): Map<string, McpTool> {
  const m = new Map<string, McpTool>();
  for (const t of tools) m.set(t.definition.name, t);
  return m;
}
