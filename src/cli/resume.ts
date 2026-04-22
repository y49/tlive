// src/cli/resume.ts — `tlive resume <session-id>`
import { ensureDaemonRunning, sendRequest } from './ipc-client-lite.js';

export async function resumeCommand(sessionId: string | undefined): Promise<void> {
  if (!sessionId) { process.stderr.write('usage: tlive resume <session-id>\n'); process.exit(2); }
  await ensureDaemonRunning();
  const resp = await sendRequest({ type: 'resume_session', payload: { sessionId } });
  if (resp.type === 'session_created') process.stdout.write(`resumed ${resp.payload.sessionId} — continue in IM\n`);
  else { process.stderr.write(`error: ${resp.type === 'error' ? resp.payload.message : 'unexpected'}\n`); process.exit(1); }
}

if (process.argv[1]?.endsWith('tlive-resume.mjs')) { await resumeCommand(process.argv[2]); }
