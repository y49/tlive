#!/usr/bin/env node
// preuninstall: best-effort stop the daemon and remove tlive's Claude hooks.
// User data in ~/.tlive (config.json, daemon.log) is preserved.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// 1. Best-effort stop the daemon (ignore if not running).
try { execSync('tlive stop', { stdio: 'ignore', timeout: 5000 }); } catch {}

// 1b. Best-effort uninstall the vendor plugins registered by `tlive setup`
//     (plugin-install.ts). Failures (vendor CLI missing / plugin not
//     installed / old vendor version) are ignored — this is cleanup, not
//     a hard requirement. Syntax confirmed via `codex plugin remove --help`:
//     `codex plugin remove <PLUGIN[@MARKETPLACE]>`.
try { execSync('claude plugin uninstall tlive@tlive -y', { stdio: 'ignore', timeout: 5000 }); } catch {}
try { execSync('codex plugin remove tlive@tlive', { stdio: 'ignore', timeout: 5000 }); } catch {}

// 2. Remove tlive's Claude hooks (tagged _tlive:true) from ~/.claude/settings.json.
//    The _tlive tag is the contract shared with plugin-install.ts's legacy strip.
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
