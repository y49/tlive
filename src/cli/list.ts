// src/cli/list.ts — `tlive list`
import { ensureDaemonRunning, sendRequest } from './ipc-client-lite.js';

export async function listCommand(): Promise<void> {
  await ensureDaemonRunning();
  const resp = await sendRequest({ type: 'list_sessions', payload: {} });
  if (resp.type !== 'session_list') {
    process.stderr.write(`error: ${resp.type === 'error' ? resp.payload.message : 'unexpected'}\n`);
    process.exit(1);
  }
  const sessions = resp.payload.sessions;
  if (sessions.length === 0) { process.stdout.write('(no active sessions)\n'); return; }
  process.stdout.write('ID                                   PROVIDER  WORKDIR              STATUS   COST\n');
  for (const s of sessions) {
    const cost = `$${s.cost.costUsd.toFixed(4)}`;
    process.stdout.write(`${s.id}  ${s.ctx.provider.padEnd(8)}  ${s.ctx.workdir.padEnd(20)}  ${s.status.padEnd(7)}  ${cost}\n`);
  }
}

if (process.argv[1]?.endsWith('tlive-list.mjs')) { await listCommand(); }
