// src/session/session.ts
//
// Legacy re-export shim. The canonical LocalSession class lives in
// `local-session.ts`; this file keeps the pre-T3 `import { Session } from
// '../session/session.js'` paths working until T8 removes the v0 bridge.
// New code should import LocalSession / SessionLike from their proper files.

export {
  LocalSession as Session,
  LocalSession,
  type SessionInit,
  type SessionEventListener,
  type SessionStatus,
} from './local-session.js';
