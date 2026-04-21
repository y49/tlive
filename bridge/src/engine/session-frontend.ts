// bridge/src/engine/session-frontend.ts
//
// Glue between daemon-level SessionManager and existing ChannelRouter.
// Phase 1 wiring: route session events → renderers → channel router.
// Phase 2 expands inbound direction (IM text → SessionManager.sendInput).

import type { SessionManager } from '../../../src/session/manager.js';
import type { ChannelRouter } from './router.js';
import type { NotificationRenderer } from '../renderers/types.js';
import type { ChannelType } from '../channels/types.js';

export class SessionFrontend {
  constructor(
    private readonly mgr: SessionManager,
    private readonly router: ChannelRouter,
    private readonly renderers: Map<ChannelType, NotificationRenderer>,
  ) {}

  start(): void {
    this.mgr.subscribe((ev) => {
      if (ev.kind === 'created') this.attachToSession(ev.session.id);
      if (ev.kind === 'resumed') this.attachToSession(ev.session.id);
    });
  }

  private attachToSession(sessionId: string): void {
    const unsub = this.mgr.subscribeToSession(sessionId, (ev) => {
      if (ev.kind !== 'event') return;
      // Phase 2 fleshes out chat target resolution; for now, broadcast to
      // whichever channel reported last (mirror SDKEngine's behaviour).
      void this.render(ev.event);
    });
    if (!unsub) return;
  }

  private async render(_event: unknown): Promise<void> {
    // Phase 2 T11: real routing. For Phase 1 this is a no-op so wiring compiles.
  }
}
