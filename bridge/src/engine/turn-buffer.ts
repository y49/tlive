import type { CanonicalEvent } from '../messages/schema.js';

export type TurnInputEvent = CanonicalEvent | { kind: 'text_complete'; text: string };

export interface TurnSummary {
  durationMs: number;
  reasoningText?: string;
  toolsStarted: Array<{ name: string; input?: unknown }>;
  filesChanged: Array<{ path: string; kind: 'add' | 'delete' | 'update' }>;
  finalText?: string;
  cost?: { inputTokens: number; outputTokens: number; costUsd: number };
}

export type OnTurnComplete = (summary: TurnSummary) => void;

export class TurnBuffer {
  private reasoningText?: string;
  private toolsStarted: Array<{ name: string; input?: unknown }> = [];
  private filesChanged: Array<{ path: string; kind: 'add' | 'delete' | 'update' }> = [];
  private finalText?: string;

  constructor(private onComplete: OnTurnComplete) {}

  push(event: TurnInputEvent): void {
    switch (event.kind) {
      case 'reasoning_complete':
        this.reasoningText = event.text;
        break;
      case 'tool_start':
        this.toolsStarted.push({ name: event.name, input: event.input });
        break;
      case 'file_change_list':
        this.filesChanged.push(...event.changes);
        break;
      case 'text_complete':
        this.finalText = event.text;
        break;
    }
  }

  completeTurn(durationMs: number, cost: TurnSummary['cost']): void {
    this.onComplete({
      durationMs,
      reasoningText: this.reasoningText,
      toolsStarted: [...this.toolsStarted],
      filesChanged: [...this.filesChanged],
      finalText: this.finalText,
      cost,
    });
    this.resetTurn();
  }

  resetTurn(): void {
    this.reasoningText = undefined;
    this.toolsStarted = [];
    this.filesChanged = [];
    this.finalText = undefined;
  }
}
