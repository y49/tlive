// src/im/turn-ui.ts
//
// TurnUI — per-turn ownership of HUD msgIds + reply msgIds. Bounded by
// turn_start (creates the instance) and turn_end+30s (destroys). Late events
// after destroy are silently dropped. HUD updates are debounced by 250ms.

import type { NotificationEvent } from '../runtime/events.js';
import type { HudState } from './hud/state.js';
import type { HudPanel } from './hud/panel.js';
import type { RenderTarget } from './render-target.js';
import { applyEventToHudState } from './hud/reducer.js';
import { targetKey } from './render-target.js';

const DEBOUNCE_MS = 250;
const DESTROY_GRACE_MS = 30_000;

export type HudPanelFactory = (target: RenderTarget) => HudPanel;

export class TurnUI {
  private state: HudState;
  private readonly hudPanels = new Map<string, HudPanel>();
  private readonly hudMsgIds = new Map<string, string>();
  private readonly primaryTargets: RenderTarget[];
  private destroyed = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyTimer: ReturnType<typeof setTimeout> | null = null;
  private frozen = false;

  constructor(
    initialState: HudState,
    targets: ReadonlyArray<RenderTarget>,
    panelFactory: HudPanelFactory,
  ) {
    this.state = initialState;
    this.primaryTargets = targets.filter(t => t.role === 'primary');
    for (const t of this.primaryTargets) {
      this.hudPanels.set(targetKey(t), panelFactory(t));
    }
  }

  /** Initial HUD send. Failures per-target are logged + swallowed. */
  async start(): Promise<void> {
    for (const t of this.primaryTargets) {
      const key = targetKey(t);
      const panel = this.hudPanels.get(key)!;
      try {
        const id = await panel.send(this.state);
        this.hudMsgIds.set(key, id);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[turn-ui] start failed target=${key} reason=${reason}\n`);
      }
    }
  }

  /** Single mutation entry point. Routes events through the pure reducer. */
  async ingestEvent(ev: NotificationEvent): Promise<void> {
    if (this.destroyed) return;
    const next = applyEventToHudState(this.state, ev);
    if (next === this.state) return;
    this.state = next;

    if (ev.kind === 'turn_end') {
      await this.freeze();
      return;
    }
    this.scheduleHudUpdate();
  }

  isDestroyed(): boolean { return this.destroyed; }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.destroyTimer) { clearTimeout(this.destroyTimer); this.destroyTimer = null; }
  }

  private scheduleHudUpdate(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flushUpdate();
    }, DEBOUNCE_MS);
  }

  private async flushUpdate(): Promise<void> {
    if (this.destroyed) return;
    for (const t of this.primaryTargets) {
      const key = targetKey(t);
      const panel = this.hudPanels.get(key);
      const msgId = this.hudMsgIds.get(key);
      if (!panel || !msgId) continue;
      try {
        await panel.update(msgId, this.state);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[turn-ui] update failed target=${key} reason=${reason}\n`);
      }
    }
  }

  private async freeze(): Promise<void> {
    if (this.frozen) return;
    this.frozen = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const t of this.primaryTargets) {
      const key = targetKey(t);
      const panel = this.hudPanels.get(key);
      const msgId = this.hudMsgIds.get(key);
      if (!panel || !msgId) continue;
      try {
        await panel.freeze(msgId, this.state);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[turn-ui] freeze failed target=${key} reason=${reason}\n`);
      }
    }
    this.destroyTimer = setTimeout(() => { this.destroyed = true; }, DESTROY_GRACE_MS);
  }
}
