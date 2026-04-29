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
  HookCallbackMatcher,
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

export interface ClaudeHookCallbacks {
  /**
   * Intercepts Claude SDK's PreToolUse hook for `AskUserQuestion`. The
   * builtin handler expects to deliver the prompt over a transport
   * channel that doesn't exist in daemon mode, so we hijack it here:
   * route to askBroker → IM ask card → resolve with chosen labels →
   * synthesize a deny+reason so SDK skips the builtin tool execution
   * but Claude still sees the user answer.
   */
  askUserQuestionPreTool?: HookCallbackMatcher['hooks'][number];
  /** Same pattern for `ExitPlanMode` (plan-mode approval has no IM UI yet). */
  exitPlanModePreTool?: HookCallbackMatcher['hooks'][number];
}

export function buildClaudeOptions(
  opts: AgentRuntimeOptions,
  canUseTool: Options['canUseTool'],
  onElicitation: Options['onElicitation'],
  hookCallbacks?: ClaudeHookCallbacks,
): Options {
  const append = (opts.systemPromptAppend ? opts.systemPromptAppend + '\n\n' : '') + IM_AWARE_SYSTEM_APPEND;
  const hooks: NonNullable<Options['hooks']> = {};
  if (hookCallbacks?.askUserQuestionPreTool || hookCallbacks?.exitPlanModePreTool) {
    const matchers: HookCallbackMatcher[] = [];
    if (hookCallbacks.askUserQuestionPreTool) {
      matchers.push({ matcher: 'AskUserQuestion', hooks: [hookCallbacks.askUserQuestionPreTool] });
    }
    if (hookCallbacks.exitPlanModePreTool) {
      matchers.push({ matcher: 'ExitPlanMode', hooks: [hookCallbacks.exitPlanModePreTool] });
    }
    hooks.PreToolUse = matchers;
  }

  const options: Options = {
    cwd: opts.workdir,
    model: opts.model,
    effort: opts.effort,
    resume: opts.resumeSessionId,
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
    hooks: Object.keys(hooks).length > 0 ? hooks : undefined,
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
