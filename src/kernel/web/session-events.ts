// src/kernel/web/session-events.ts
//
// Pure orchestration: map a vendor-neutral MonitorEvent onto the registry and
// produce the EventFrame to broadcast. No IM, no vendor field names.

import type { SessionRegistry } from './session-registry.js';
import type { EventFrame } from './event-hub.js';
import type { MonitorEvent } from '../hook/normalizer.js';

export function applyMonitorEvent(sessions: SessionRegistry, evt: MonitorEvent): EventFrame {
  switch (evt.event) {
    case 'activity':
      return { type: 'session-upsert', session: sessions.upsert({ cwd: evt.cwd, status: 'active' }) };
    case 'attention':
      return { type: 'session-upsert', session: sessions.upsert({ cwd: evt.cwd, status: 'waiting-input', lastMessage: evt.lastMessage ?? evt.message }) };
    case 'prompt':
      return { type: 'session-upsert', session: sessions.upsert({ cwd: evt.cwd, status: 'active', lastPrompt: evt.prompt }) };
    case 'session-start':
      return { type: 'session-upsert', session: sessions.upsert({ cwd: evt.cwd, kind: 'hook', status: 'idle' }) };
    case 'session-end': {
      const removed = sessions.remove(evt.cwd);
      return { type: 'session-remove', id: removed?.id ?? evt.cwd };
    }
  }
}
