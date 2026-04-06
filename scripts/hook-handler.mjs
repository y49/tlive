#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Read stdin
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
}

const sessionId = process.env.TLIVE_SESSION_ID;
if (!sessionId) process.exit(0);

const pauseFile = join(homedir(), '.tlive', 'hooks-paused');
if (existsSync(pauseFile)) process.exit(0);

// Parse and inject session info
let hookJson;
try {
  hookJson = JSON.parse(input);
} catch { process.exit(0); }
hookJson.tlive_session_id = sessionId;
hookJson.tlive_cwd = process.cwd();

// Load config
let port = '4590';
let token = '';
const configPath = join(homedir(), '.tlive', 'config.env');
if (existsSync(configPath)) {
  try {
    const lines = readFileSync(configPath, 'utf-8').split('\n');
    for (const line of lines) {
      const match = line.match(/^(?:export\s+)?(\w+)=["']?(.*?)["']?\s*$/);
      if (match) {
        if (match[1] === 'TL_PORT') port = match[2];
        if (match[1] === 'TL_TOKEN') token = match[2];
      }
    }
  } catch {}
}

const baseUrl = `http://localhost:${port}`;
const headers = {
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json',
};

const eventName = hookJson.hook_event_name || '';
const toolName = hookJson.tool_name || '';
const TLIVE_DIR = join(homedir(), '.tlive');

// ---------------------------------------------------------------------------
// PostToolUse + AskUserQuestion: read saved IM answer, inject as additionalContext
// This is the reliable path — interactive PTY mode ignores updatedInput for
// AskUserQuestion, so we tell Claude the answer AFTER the tool completes.
// ---------------------------------------------------------------------------
if (eventName === 'PostToolUse' && toolName === 'AskUserQuestion') {
  const answerFile = join(TLIVE_DIR, `askq-answer-${sessionId}.json`);
  if (existsSync(answerFile)) {
    try {
      const saved = JSON.parse(readFileSync(answerFile, 'utf-8'));
      unlinkSync(answerFile);
      // Build human-readable answer summary
      const lines = Object.entries(saved).map(([q, a]) => `${a}`);
      const summary = lines.join(', ');
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: `[TermLive] User answered via IM: ${summary}`,
        },
      }));
    } catch {
      // File read/parse failed — nothing to inject
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// PermissionRequest / other hooks: forward to Core for IM-based resolution
// ---------------------------------------------------------------------------

// Check if core is running
try {
  const status = await fetch(`${baseUrl}/api/status`, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!status.ok) process.exit(0);
} catch {
  process.exit(0);
}

// Long-poll permission endpoint (up to 300s)
let response;
try {
  response = await fetch(`${baseUrl}/api/hooks/permission`, {
    method: 'POST',
    headers,
    body: JSON.stringify(hookJson),
    signal: AbortSignal.timeout(300_000),
  });
} catch {
  process.exit(0);
}

if (!response.ok) process.exit(0);

let body;
try {
  body = await response.json();
} catch {
  process.exit(0);
}

const decision = body.decision || 'allow';
const updatedInput = body.updated_input;

// For AskUserQuestion: save the IM answer so PostToolUse can inject it as context.
// updatedInput.answers contains { "question text": "selected label" }.
if (toolName === 'AskUserQuestion' && updatedInput?.answers) {
  try {
    mkdirSync(TLIVE_DIR, { recursive: true });
    writeFileSync(
      join(TLIVE_DIR, `askq-answer-${sessionId}.json`),
      JSON.stringify(updatedInput.answers),
    );
  } catch {}
}

// PermissionRequest: handles all tool permissions including AskUserQuestion
switch (decision) {
  case 'allow': {
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    };
    if (updatedInput) {
      output.hookSpecificOutput.decision.updatedInput = updatedInput;
    }
    process.stdout.write(JSON.stringify(output));
    break;
  }
  case 'allow_always': {
    const suggestions = body.suggestions || [];
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedPermissions: suggestions },
      },
    };
    if (updatedInput) {
      output.hookSpecificOutput.decision.updatedInput = updatedInput;
    }
    process.stdout.write(JSON.stringify(output));
    break;
  }
  case 'deny':
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny' },
      },
    }));
    break;
}
