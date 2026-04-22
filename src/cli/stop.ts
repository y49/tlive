// src/cli/stop.ts — `tlive stop <session-id>`
import { ensureDaemonRunning, sendRequest } from './ipc-client-lite.js';

export async function stopCommand(sessionId: string | undefined): Promise<void> {
  if (!sessionId) { process.stderr.write('usage: tlive stop <session-id>\n'); process.exit(2); }
  await ensureDaemonRunning();
  const resp = await sendRequest({ type: 'stop_session', payload: { sessionId } });
  if (resp.type === 'ack') process.stdout.write(`stopped ${sessionId}\n`);
  else { process.stderr.write(`error: ${resp.type === 'error' ? resp.payload.message : 'unexpected'}\n`); process.exit(1); }
}

if (process.argv[1]?.endsWith('tlive-stop.mjs')) { await stopCommand(process.argv[2]); }
