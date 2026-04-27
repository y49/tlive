// src/runtime/claude/options-builder.ts
//
// Constructs the Options object passed to @anthropic-ai/claude-agent-sdk's
// query() from an AgentRuntimeOptions. Encodes the tlive-specific IM-aware
// system-prompt append and the per-provider defaults (partial messages on,
// file checkpointing on, session persistence on, prompt suggestions on).

import type {
  Options,
  PermissionMode as SdkPermissionMode,
  McpServerConfig as SdkMcpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentRuntimeOptions } from '../types.js';

const IM_AWARE_SYSTEM_APPEND = `
You are being invoked from an IM bridge. Optimize your responses for mobile IM reading:
- Prefer terse Markdown. Attach long code (>40 lines), diffs (>100 lines), and reference
  documents as files via the Write tool — do not inline them in the conversation.
- When asking the user for input, use the AskUserQuestion tool so it renders as buttons
  rather than free-form prose.
- Users may type terse, typo-prone, or fragmentary messages from mobile keyboards;
  interpret charitably.
- Long bash output, file reads >300 lines, and search results should be summarized in
  conversation and the full output written to ./tlive-artifacts/<timestamp>-<name>.
`.trim();

export function buildClaudeOptions(
  opts: AgentRuntimeOptions,
  canUseTool: Options['canUseTool'],
  onElicitation: Options['onElicitation'],
): Options {
  const append = (opts.systemPromptAppend ? opts.systemPromptAppend + '\n\n' : '') + IM_AWARE_SYSTEM_APPEND;
  const options: Options = {
    cwd: opts.workdir,
    model: opts.model,
    effort: opts.effort,
    resume: opts.resumeSdkSessionId ?? opts.resumeSessionId,
    permissionMode: mapPermissionMode(opts.permissionMode),
    canUseTool,
    onElicitation,
    thinking: opts.thinking,
    includePartialMessages: opts.includePartialMessages ?? true,
    enableFileCheckpointing: opts.enableFileCheckpointing ?? true,
    persistSession: opts.persistSession ?? true,
    maxBudgetUsd: opts.maxBudgetUsd,
    mcpServers: opts.mcpServers as unknown as Record<string, SdkMcpServerConfig> | undefined,
    permissionPromptToolName: opts.permissionPromptToolName,
    promptSuggestions: opts.promptSuggestions ?? true,
    systemPrompt: { type: 'preset', preset: 'claude_code', append },
  };
  return options;
}

function mapPermissionMode(mode: AgentRuntimeOptions['permissionMode']): SdkPermissionMode | undefined {
  if (!mode) return undefined;
  // tlive-internal modes map onto SDK's mode surface. yolo / safe-yolo fold
  // into SDK's bypassPermissions with the `allowDangerouslySkipPermissions`
  // guard applied by the caller when selecting yolo.
  switch (mode) {
    case 'yolo':
    case 'safe-yolo':
    case 'bypassPermissions':
      return 'bypassPermissions';
    case 'acceptEdits':
    case 'plan':
    case 'default':
    case 'dontAsk':
      return mode;
    default:
      return undefined;
  }
}
