import type { CanonicalEvent } from '../messages/schema.js';

export interface PermissionContext {
  reasoning?: string;
  recentTools: Array<{ name: string; input?: unknown }>;
}

export interface PermissionContextOptions {
  maxTools: number;
}

export class PermissionContextCollector {
  private reasoning?: string;
  private tools: Array<{ name: string; input?: unknown }> = [];

  constructor(private opts: PermissionContextOptions) {}

  observe(event: CanonicalEvent): void {
    if (event.kind === 'reasoning_complete') {
      this.reasoning = event.text;
    } else if (event.kind === 'tool_start') {
      this.tools.push({ name: event.name, input: event.input });
      if (this.tools.length > this.opts.maxTools) {
        this.tools.splice(0, this.tools.length - this.opts.maxTools);
      }
    }
  }

  snapshot(): PermissionContext {
    return { reasoning: this.reasoning, recentTools: [...this.tools] };
  }

  reset(): void {
    this.reasoning = undefined;
    this.tools = [];
  }
}
