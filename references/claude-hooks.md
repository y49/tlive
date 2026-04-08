# Claude Code Hooks Reference

> Source: https://code.claude.com/docs/en/hooks
> Fetched: 2026-04-07

Hooks are user-defined shell commands, HTTP endpoints, or LLM prompts that execute automatically at specific points in the Claude Code lifecycle.

## Hook Events Summary

| Event | When it fires | Can block? |
|:---|:---|:---|
| `SessionStart` | Session begins or resumes | No |
| `UserPromptSubmit` | Prompt submitted, before processing | Yes |
| `PreToolUse` | Before a tool call executes | Yes |
| `PermissionRequest` | Permission dialog appears | Yes |
| `PermissionDenied` | Auto mode classifier denies a tool call | No (retry only) |
| `PostToolUse` | After a tool call succeeds | No |
| `PostToolUseFailure` | After a tool call fails | No |
| `Notification` | Claude Code sends a notification | No |
| `SubagentStart` | Subagent spawned | No |
| `SubagentStop` | Subagent finishes | Yes |
| `TaskCreated` | Task created via TaskCreate | Yes |
| `TaskCompleted` | Task marked completed | Yes |
| `Stop` | Claude finishes responding | Yes |
| `StopFailure` | Turn ends due to API error | No |
| `TeammateIdle` | Agent team teammate about to go idle | Yes |
| `ConfigChange` | Config file changes during session | Yes |
| `CwdChanged` | Working directory changes | No |
| `FileChanged` | Watched file changes on disk | No |
| `WorktreeCreate` | Worktree being created | Yes |
| `WorktreeRemove` | Worktree being removed | No |
| `PreCompact` | Before context compaction | No |
| `PostCompact` | After context compaction | No |
| `Elicitation` | MCP server requests user input | Yes |
| `ElicitationResult` | User responds to MCP elicitation | Yes |
| `SessionEnd` | Session terminates | No |
| `InstructionsLoaded` | CLAUDE.md or rules file loaded | No |

## Configuration

### Hook Locations

| Location | Scope | Shareable |
|:---|:---|:---|
| `~/.claude/settings.json` | All projects | No |
| `.claude/settings.json` | Single project | Yes |
| `.claude/settings.local.json` | Single project | No, gitignored |
| Managed policy settings | Organization-wide | Yes, admin-controlled |
| Plugin `hooks/hooks.json` | When plugin enabled | Yes |
| Skill/agent frontmatter | While component active | Yes |

### Matcher Patterns

The `matcher` field is a regex string. Use `"*"`, `""`, or omit to match all.

| Event | What matcher filters | Example |
|:---|:---|:---|
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied` | Tool name | `Bash`, `Edit\|Write`, `mcp__.*` |
| `SessionStart` | How session started | `startup`, `resume`, `clear`, `compact` |
| `SessionEnd` | Why session ended | `clear`, `resume`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled`, `other` |
| `Notification` | Notification type | `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog` |
| `SubagentStart` / `SubagentStop` | Agent type | `Bash`, `Explore`, `Plan`, custom names |
| `PreCompact` / `PostCompact` | Compaction trigger | `manual`, `auto` |
| `ConfigChange` | Config source | `user_settings`, `project_settings`, `local_settings`, `policy_settings`, `skills` |
| `FileChanged` | Filename (basename) | `.envrc`, `.env` |
| `StopFailure` | Error type | `rate_limit`, `authentication_failed`, `billing_error`, `invalid_request`, `server_error`, `max_output_tokens`, `unknown` |
| `InstructionsLoaded` | Load reason | `session_start`, `nested_traversal`, `path_glob_match`, `include`, `compact` |
| `Elicitation` / `ElicitationResult` | MCP server name | Your configured MCP server names |
| `UserPromptSubmit`, `Stop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `WorktreeCreate`, `WorktreeRemove`, `CwdChanged` | No matcher support | Always fires |

## Hook Handler Types

### Common Fields

| Field | Required | Description |
|:---|:---|:---|
| `type` | Yes | `"command"`, `"http"`, `"prompt"`, or `"agent"` |
| `if` | No | Permission rule syntax filter (e.g. `"Bash(git *)"`, `"Edit(*.ts)"`). Only on tool events |
| `timeout` | No | Seconds before cancel. Defaults: command 600, prompt 30, agent 60 |
| `statusMessage` | No | Custom spinner message while hook runs |
| `once` | No | If `true`, runs only once per session then removed. Skills only |

### Command Hook Fields

| Field | Required | Description |
|:---|:---|:---|
| `command` | Yes | Shell command to execute |
| `async` | No | If `true`, run in background without blocking |
| `shell` | No | `"bash"` (default) or `"powershell"` |

### HTTP Hook Fields

| Field | Required | Description |
|:---|:---|:---|
| `url` | Yes | URL to send POST request |
| `headers` | No | Additional HTTP headers. Values support env var interpolation `$VAR_NAME` |
| `allowedEnvVars` | No | List of env var names allowed for interpolation |

Error handling: non-2xx responses, connection failures, and timeouts all produce **non-blocking** errors. To block, return 2xx with appropriate decision JSON.

### Prompt and Agent Hook Fields

| Field | Required | Description |
|:---|:---|:---|
| `prompt` | Yes | Prompt text. Use `$ARGUMENTS` as placeholder for hook input JSON |
| `model` | No | Model for evaluation. Defaults to fast model |

Agent hooks spawn a subagent with tool access (Read, Grep, Glob). Up to 50 turns.

## Hook Input and Output

### Common Input Fields

| Field | Description |
|:---|:---|
| `session_id` | Current session identifier |
| `transcript_path` | Path to conversation JSON |
| `cwd` | Current working directory |
| `permission_mode` | Current permission mode |
| `hook_event_name` | Name of triggered event |

When running with `--agent` or inside a subagent:

| Field | Description |
|:---|:---|
| `agent_id` | Subagent's unique identifier |
| `agent_type` | Agent name (e.g. `"Explore"`) |

### Exit Code Behavior

- **Exit 0**: Success. Parse stdout for JSON output.
- **Exit 2**: Blocking error. stderr fed back to Claude.
- **Other**: Non-blocking error. stderr shown in verbose mode.

#### Exit Code 2 Per Event

| Hook Event | Can block? | What happens on exit 2 |
|:---|:---|:---|
| `PreToolUse` | Yes | Blocks the tool call |
| `PermissionRequest` | Yes | Denies the permission |
| `UserPromptSubmit` | Yes | Blocks prompt, erases it |
| `Stop` | Yes | Prevents stopping, continues conversation |
| `SubagentStop` | Yes | Prevents subagent from stopping |
| `TeammateIdle` | Yes | Keeps teammate working |
| `TaskCreated` | Yes | Rolls back task creation |
| `TaskCompleted` | Yes | Prevents completion |
| `ConfigChange` | Yes | Blocks config change (except `policy_settings`) |
| `Elicitation` | Yes | Denies elicitation |
| `ElicitationResult` | Yes | Blocks response (action becomes decline) |
| `WorktreeCreate` | Yes | Any non-zero fails creation |
| `StopFailure` | No | Output and exit code ignored |
| `PostToolUse` | No | Shows stderr to Claude |
| `PostToolUseFailure` | No | Shows stderr to Claude |
| `PermissionDenied` | No | Exit code ignored. Use JSON `retry: true` |
| `Notification` | No | Shows stderr to user only |
| `SubagentStart` | No | Shows stderr to user only |
| `SessionStart` | No | Shows stderr to user only |
| `SessionEnd` | No | Shows stderr to user only |
| `CwdChanged` | No | Shows stderr to user only |
| `FileChanged` | No | Shows stderr to user only |
| `PreCompact` | No | Shows stderr to user only |
| `PostCompact` | No | Shows stderr to user only |
| `InstructionsLoaded` | No | Exit code ignored |
| `WorktreeRemove` | No | Logged in debug mode only |

### HTTP Response Handling

- **2xx empty body**: success, equivalent to exit 0 with no output
- **2xx plain text body**: success, text added as context
- **2xx JSON body**: success, parsed using JSON output schema
- **Non-2xx**: non-blocking error, continues
- **Connection failure/timeout**: non-blocking error, continues

### JSON Output Fields

| Field | Default | Description |
|:---|:---|:---|
| `continue` | `true` | If `false`, Claude stops processing entirely |
| `stopReason` | none | Message shown to user when `continue` is `false` |
| `suppressOutput` | `false` | If `true`, hide stdout from verbose mode |
| `systemMessage` | none | Warning message shown to user |

Hook output injected into context is capped at 10,000 characters.

### Decision Control Summary

| Events | Decision pattern | Key fields |
|:---|:---|:---|
| UserPromptSubmit, PostToolUse, PostToolUseFailure, Stop, SubagentStop, ConfigChange | Top-level `decision` | `decision: "block"`, `reason` |
| TeammateIdle, TaskCreated, TaskCompleted | Exit code or `continue: false` | Exit 2 blocks with stderr. JSON `{"continue": false}` stops teammate |
| PreToolUse | `hookSpecificOutput` | `permissionDecision` (allow/deny/ask/defer), `permissionDecisionReason` |
| PermissionRequest | `hookSpecificOutput` | `decision.behavior` (allow/deny) |
| PermissionDenied | `hookSpecificOutput` | `retry: true` |
| WorktreeCreate | Path return | stdout (command) or `hookSpecificOutput.worktreePath` (HTTP) |
| Elicitation / ElicitationResult | `hookSpecificOutput` | `action` (accept/decline/cancel), `content` |
| All others | None | No decision control, side effects only |

---

## Hook Events (Detailed)

### SessionStart

Runs when Claude Code starts or resumes a session. **Only `type: "command"` hooks supported.**

Matcher values: `startup`, `resume`, `clear`, `compact`

Input fields: `source`, `model`, optional `agent_type`

Can return `additionalContext` in `hookSpecificOutput`. Has access to `CLAUDE_ENV_FILE` for persisting environment variables.

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "SessionStart",
  "source": "startup",
  "model": "claude-sonnet-4-6"
}
```

### UserPromptSubmit

Runs when user submits a prompt, before Claude processes it.

Input: `prompt` field with submitted text.

Decision: `decision: "block"` prevents prompt processing and erases it. Can add `additionalContext`.

```json
{
  "decision": "block",
  "reason": "Explanation",
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Context here"
  }
}
```

### PreToolUse

Runs before a tool call executes. Matches on tool name.

Tools: `Bash`, `Edit`, `Write`, `Read`, `Glob`, `Grep`, `Agent`, `WebFetch`, `WebSearch`, `AskUserQuestion`, `ExitPlanMode`, MCP tools.

#### PreToolUse Tool Input Schemas

**Bash**: `command`, `description`, `timeout`, `run_in_background`

**Write**: `file_path`, `content`

**Edit**: `file_path`, `old_string`, `new_string`, `replace_all`

**Read**: `file_path`, `offset`, `limit`

**Glob**: `pattern`, `path`

**Grep**: `pattern`, `path`, `glob`, `output_mode`, `-i`, `multiline`

**WebFetch**: `url`, `prompt`

**WebSearch**: `query`, `allowed_domains`, `blocked_domains`

**Agent**: `prompt`, `description`, `subagent_type`, `model`

**AskUserQuestion**: `questions` (array), `answers` (object)

#### PreToolUse Decision Control

| Field | Description |
|:---|:---|
| `permissionDecision` | `"allow"` skips permission. `"deny"` blocks. `"ask"` prompts user. `"defer"` pauses for later resume |
| `permissionDecisionReason` | For allow/ask: shown to user. For deny: shown to Claude. For defer: ignored |
| `updatedInput` | Modify tool input before execution. Replaces entire input object |
| `additionalContext` | String added to Claude's context |

Priority: `deny` > `defer` > `ask` > `allow`

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Reason",
    "updatedInput": { "field": "new value" },
    "additionalContext": "Context here"
  }
}
```

#### Defer (non-interactive mode only)

For `claude -p` subprocess integrations. Pauses Claude at tool call, calling process collects input, resumes with `claude -p --resume <session-id>`. Only works when Claude makes a single tool call in the turn.

SDK result includes `deferred_tool_use` with `id`, `name`, `input`. No timeout or retry limit.

### PermissionRequest

Runs when permission dialog is about to be shown. Matches on tool name.

Input: `tool_name`, `tool_input`, `permission_suggestions` array.

```json
{
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": { "command": "rm -rf node_modules" },
  "permission_suggestions": [
    {
      "type": "addRules",
      "rules": [{ "toolName": "Bash", "ruleContent": "rm -rf node_modules" }],
      "behavior": "allow",
      "destination": "localSettings"
    }
  ]
}
```

#### PermissionRequest Decision Control

| Field | Description |
|:---|:---|
| `behavior` | `"allow"` grants, `"deny"` denies |
| `updatedInput` | For allow only: modify tool input |
| `updatedPermissions` | For allow only: array of permission update entries |
| `message` | For deny only: tells Claude why |
| `interrupt` | For deny only: if `true`, stops Claude |

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedInput": { "command": "npm run lint" }
    }
  }
}
```

#### Permission Update Entries

| `type` | Fields | Effect |
|:---|:---|:---|
| `addRules` | `rules`, `behavior`, `destination` | Add permission rules |
| `replaceRules` | `rules`, `behavior`, `destination` | Replace all rules of given behavior |
| `removeRules` | `rules`, `behavior`, `destination` | Remove matching rules |
| `setMode` | `mode`, `destination` | Change permission mode |
| `addDirectories` | `directories`, `destination` | Add working directories |
| `removeDirectories` | `directories`, `destination` | Remove working directories |

Destinations: `session`, `localSettings`, `projectSettings`, `userSettings`

### PostToolUse

Runs after a tool call succeeds. Matches on tool name.

Input: `tool_name`, `tool_input`, `tool_response`, `tool_use_id`

Decision: `decision: "block"` with `reason`. Can return `additionalContext` and `updatedMCPToolOutput` (MCP tools only).

```json
{
  "hook_event_name": "PostToolUse",
  "tool_name": "Write",
  "tool_input": { "file_path": "/path/to/file.txt", "content": "..." },
  "tool_response": { "filePath": "/path/to/file.txt", "success": true },
  "tool_use_id": "toolu_01ABC123..."
}
```

### PostToolUseFailure

Runs when a tool execution fails. Matches on tool name.

Input: `tool_name`, `tool_input`, `tool_use_id`, `error`, `is_interrupt`

Can return `additionalContext`.

### PermissionDenied

Runs when auto mode classifier denies a tool call. **Only fires in auto mode.**

Input: `tool_name`, `tool_input`, `tool_use_id`, `reason`

Decision: Return `hookSpecificOutput.retry: true` to tell model it may retry.

### Notification

Matches on notification type: `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`.

Input: `message`, `title`, `notification_type`

No blocking control. Can return `additionalContext`.

### Stop

Runs when Claude finishes responding. No matcher support.

Input: `last_assistant_message`

Decision: `decision: "block"` with `reason` prevents stopping, forces another turn.

```json
{
  "decision": "block",
  "reason": "Tests are still failing. Continue fixing them."
}
```

### StopFailure

Runs when turn ends due to API error. **Output and exit code are ignored.**

Matcher values: `rate_limit`, `authentication_failed`, `billing_error`, `invalid_request`, `server_error`, `max_output_tokens`, `unknown`

Input: `error_type`, `error_message`

### SubagentStart

Runs when subagent spawned. Matches on agent type.

Input: `agent_id`, `agent_type`

Can return `additionalContext`. Cannot block.

### SubagentStop

Runs when subagent finishes. Matches on agent type.

Input: `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`

Same decision control as Stop hooks.

### TaskCreated

Runs when task created via TaskCreate. No matcher support.

Input: `task_id`, `task_subject`, optional `task_description`, `teammate_name`, `team_name`

Exit 2 rolls back creation. JSON `{"continue": false}` stops teammate.

### TaskCompleted

Runs when task marked completed. No matcher support.

Same input and decision control as TaskCreated.

### TeammateIdle

Runs when agent team teammate about to go idle. No matcher support.

Input: `teammate_name`, `team_name`, `last_assistant_message`, `teammate_transcript_path`

Exit 2 keeps teammate working. JSON `{"continue": false}` stops teammate.

### ConfigChange

Runs when config file changes during session.

Matcher values: `user_settings`, `project_settings`, `local_settings`, `policy_settings`, `skills`

Input: `config_source`, optional `changed_keys`

Decision: `decision: "block"` prevents change (except `policy_settings`).

### CwdChanged

Runs when working directory changes. No matcher support.

Input: `old_cwd`, `new_cwd`

No decision control. Has `CLAUDE_ENV_FILE` access.

### FileChanged

Runs when watched file changes. Matcher specifies filenames (basename).

Input: `file_path`, `change_type` (`"created"`, `"modified"`, `"deleted"`)

No decision control. Has `CLAUDE_ENV_FILE` access.

### WorktreeCreate

Runs when worktree being created. Replaces default git behavior.

Input: `worktree_name`, optional `commit_hash`

Must exit 0 and print path to stdout. Any non-zero fails creation.

### WorktreeRemove

Cleanup counterpart. Input: `worktree_path`. No decision control.

### PreCompact / PostCompact

Pre runs before compaction, Post after. Matcher: `manual`, `auto`.

Input: `compaction_trigger`

No decision control.

### Elicitation

Runs when MCP server requests user input. Matches on MCP server name.

Input: `mcp_server_name`, `tool_name`, `form_schema`

Decision: `action` (accept/decline/cancel), `content` (form values for accept).

### ElicitationResult

Runs after user responds to MCP elicitation. Matches on MCP server name.

Input: `mcp_server_name`, `tool_name`, `form_schema`, `user_response`

Decision: `action` (accept/decline/cancel), `content` (modified values).

### SessionEnd

Runs when session terminates. Default timeout 1.5s (configurable via `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`).

Matcher values: `clear`, `resume`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled`, `other`

Input: `reason`

No decision control.

### InstructionsLoaded

Fires when CLAUDE.md or `.claude/rules/*.md` loaded.

Matcher values: `session_start`, `nested_traversal`, `path_glob_match`, `include`, `compact`

Input: `file_path`, `memory_type`, `load_reason`, optional `globs`, `trigger_file_path`, `parent_file_path`

No decision control. Exit code ignored.

---

## Async Hooks

Set `"async": true` on command hooks to run in background. Async hooks **cannot block or return decisions**. Output delivered on next conversation turn. Only `type: "command"` supports async.

## Security Considerations

Command hooks run with full user system permissions. Always validate/sanitize input, quote shell variables, block path traversal, use absolute paths, and skip sensitive files.

## Debugging

Run `claude --debug` to see hook execution details. Set `CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose` for extra hook matching details.

## Supported Hook Types Per Event

Events supporting all four types (command, http, prompt, agent):
- PermissionRequest, PostToolUse, PostToolUseFailure, PreToolUse, Stop, SubagentStop, TaskCompleted, TaskCreated, UserPromptSubmit

Events supporting only command and http (NOT prompt or agent):
- ConfigChange, CwdChanged, Elicitation, ElicitationResult, FileChanged, InstructionsLoaded, Notification, PermissionDenied, PostCompact, PreCompact, SessionEnd, StopFailure, SubagentStart, TeammateIdle, WorktreeCreate, WorktreeRemove

SessionStart: only `command` hooks.
