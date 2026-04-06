#!/usr/bin/env node
// Claude Code Status Line script for TermLive
// Reads JSON session data from stdin, queries Go Core, outputs status line.
// Configure in ~/.claude/settings.json:
//   { "statusLine": { "command": "node ~/.tlive/bin/statusline.mjs" } }
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const home = homedir();

// Read session JSON from stdin
let sessionJson = '';
for await (const chunk of process.stdin) sessionJson += chunk;

// Load config
let port = '4590';
let token = '';
const configPath = join(home, '.tlive', 'config.env');
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

// Extract from session JSON
let tokensIn = '?', tokensOut = '?', cost = '?';
try {
  const session = JSON.parse(sessionJson);
  tokensIn = String(session.token_usage?.input ?? '?');
  tokensOut = String(session.token_usage?.output ?? '?');
  cost = String(session.cost_usd ?? '?');
} catch {}

// Query Go Core
let sessions = '?', bridge = '?';
try {
  const res = await fetch(`http://localhost:${port}/api/status`, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(3000),
  });
  if (res.ok) {
    const data = await res.json();
    sessions = String(data.active_sessions ?? '?');
    bridge = data.bridge?.connected ? 'on' : 'off';
  }
} catch {}

console.log(`TL: ${sessions}sess | bridge:${bridge} | ${tokensIn}/${tokensOut}tok | $${cost}`);
