// src/kernel/daemon/inject.ts
//
// Inject text into a wrapped session's pty by connecting to its per-session
// socket as a plain client. Uses BRACKETED PASTE so a full-screen TUI (claude)
// receives it as one pasted block — not interpreted keystroke-by-keystroke —
// followed by a lone Enter to submit. A Data-only client carries no size, so
// it never steals the layout authority.

import { createConnection } from 'node:net';
import { encodeData } from '../web/stream-protocol.js';

export function bracketedPaste(text: string): Buffer {
  // Strip embedded paste markers so injected content can't break OUT of paste
  // mode and have its tail interpreted as keystrokes (a control-sequence
  // injection). Also drop bare CR/LF-adjacent NULs that some pastes carry.
  const clean = text.replace(/\x1b\[20[01]~/g, '');
  return Buffer.concat([
    Buffer.from('\x1b[200~', 'ascii'),
    Buffer.from(clean, 'utf8'),
    Buffer.from('\x1b[201~\r', 'ascii'),
  ]);
}

/** Connect → write one Data frame → close. Rejects on connect error/timeout. */
export function injectInput(sockPath: string, text: string, timeoutMs = 3000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const sock = createConnection(sockPath);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('inject timeout')); }, timeoutMs);
    timer.unref();
    sock.on('connect', () => {
      sock.write(encodeData(bracketedPaste(text)), (err) => {
        clearTimeout(timer);
        sock.end();
        if (err) reject(err); else resolve();
      });
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
