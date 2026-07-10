#!/usr/bin/env node
// preuninstall: best-effort stop the daemon and uninstall the vendor plugins.
// User data in ~/.tlive (config.json, daemon.log) is preserved.
import { execSync } from 'node:child_process';

// 1. Best-effort stop the daemon (ignore if not running).
try { execSync('tlive stop', { stdio: 'ignore', timeout: 5000 }); } catch {}

// 1b. Best-effort uninstall the vendor plugins registered by `tlive setup`
//     (plugin-install.ts). Failures (vendor CLI missing / plugin not
//     installed / old vendor version) are ignored — this is cleanup, not
//     a hard requirement. Syntax confirmed via each CLI's `--help`:
//     `claude plugin uninstall <plugin>` (no -y — that flag only exists for
//     --prune; an unknown flag would error and silently skip the cleanup) and
//     `codex plugin remove <PLUGIN[@MARKETPLACE]>`.
try { execSync('claude plugin uninstall tlive@tlive', { stdio: 'ignore', timeout: 5000 }); } catch {}
try { execSync('codex plugin remove tlive@tlive', { stdio: 'ignore', timeout: 5000 }); } catch {}

console.log('tlive uninstalled. ~/.tlive (config, logs) preserved.');
