#!/usr/bin/env node
// preuninstall: best-effort stop the daemon and remove tlive's Claude hooks.
// User data in ~/.tlive (config.json, daemon.log) is preserved.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// 1. Best-effort stop the daemon (ignore if not running).
try { execSync('tlive stop', { stdio: 'ignore', timeout: 5000 }); } catch {}

// 2. Remove tlive's Claude hooks (tagged _tlive:true) from ~/.claude/settings.json.
//    The _tlive tag is the contract shared with install-hooks.ts (installClaudeHooks).
function removeTliveHooks() {
  const p = join(homedir(), '.claude', 'settings.json');
  if (!existsSync(p)) return;
  try {
    const cfg = JSON.parse(readFileSync(p, 'utf-8'));
    const hooks = cfg.hooks;
    if (!hooks || typeof hooks !== 'object') return;
    let changed = false;
    for (const event of Object.keys(hooks)) {
      const groups = hooks[event];
      if (!Array.isArray(groups)) continue;
      const filtered = groups.filter((g) => !(g.hooks ?? []).some((h) => h && h._tlive));
      if (filtered.length !== groups.length) {
        changed = true;
        if (filtered.length === 0) delete hooks[event];
        else hooks[event] = filtered;
      }
    }
    if (changed) {
      writeFileSync(p, JSON.stringify(cfg, null, 2));
      console.log('Removed tlive hooks from ~/.claude/settings.json');
    }
  } catch { /* malformed settings — leave it alone */ }
}

removeTliveHooks();
console.log('tlive uninstalled. ~/.tlive (config, logs) preserved.');
