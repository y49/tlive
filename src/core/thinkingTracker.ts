// src/core/thinkingTracker.ts
import { EventEmitter } from 'node:events';

export class ThinkingTracker extends EventEmitter {
  private activeToolCalls = new Set<string>();
  private _isThinking = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 500;

  get isThinking(): boolean { return this._isThinking; }

  trackToolUse(toolUseId: string): void {
    this.activeToolCalls.add(toolUseId);
    this.updateState(true);
  }

  trackToolResult(toolUseId: string): void {
    this.activeToolCalls.delete(toolUseId);
    if (this.activeToolCalls.size === 0) {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        if (this.activeToolCalls.size === 0) this.updateState(false);
      }, this.DEBOUNCE_MS);
    }
  }

  trackAssistantMessage(): void {
    this.activeToolCalls.clear();
    this.updateState(false);
  }

  private updateState(thinking: boolean): void {
    if (thinking === this._isThinking) return;
    this._isThinking = thinking;
    this.emit('change', thinking);
  }

  reset(): void {
    this.activeToolCalls.clear();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this._isThinking = false;
  }
}
