// src/mcp/self/prompts.ts
//
// Named prompt templates. `prompts/list` returns definitions; `prompts/get`
// fetches data at call time (so each use sees the freshest workspace state).
//
// Six templates (spec §9.5):
//   - tlive-daily-standup
//   - tlive-review-session <alias>
//   - tlive-cross-search <query>
//   - tlive-team-digest
//   - tlive-explain-error <event-id>
//   - tlive-continue-plan

import type { McpToolDeps } from './deps.js';

export interface PromptArgumentSpec {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptDefinition {
  name: string;
  description: string;
  arguments?: PromptArgumentSpec[];
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

export interface PromptResult {
  description?: string;
  messages: PromptMessage[];
}

/**
 * Prompt registry. Factory so tests inject lightweight deps; production wires
 * the daemon's SessionManager + WorkspaceManager.
 */
export class PromptRegistry {
  constructor(private readonly deps: McpToolDeps) {}

  list(): PromptDefinition[] {
    return [
      {
        name: 'tlive-daily-standup',
        description: "Assemble yesterday's session activity into a standup draft.",
      },
      {
        name: 'tlive-review-session',
        description: 'Review a session transcript and produce feedback.',
        arguments: [{ name: 'alias', required: true }],
      },
      {
        name: 'tlive-cross-search',
        description: 'Run a formatted cross-session search.',
        arguments: [{ name: 'query', required: true }],
      },
      {
        name: 'tlive-team-digest',
        description: 'Multi-workspace activity digest.',
      },
      {
        name: 'tlive-explain-error',
        description: 'Explain a runtime error event in plain English.',
        arguments: [{ name: 'event_id', required: true }],
      },
      {
        name: 'tlive-continue-plan',
        description: "Resume the workspace's active plan.",
      },
    ];
  }

  async get(name: string, args: Record<string, string>, workspaceId: string): Promise<PromptResult | null> {
    switch (name) {
      case 'tlive-daily-standup':      return this.dailyStandup(workspaceId);
      case 'tlive-review-session':     return this.reviewSession(args.alias ?? '');
      case 'tlive-cross-search':       return this.crossSearch(args.query ?? '', workspaceId);
      case 'tlive-team-digest':        return this.teamDigest();
      case 'tlive-explain-error':      return this.explainError(args.event_id ?? '');
      case 'tlive-continue-plan':      return this.continuePlan(workspaceId);
      default:                         return null;
    }
  }

  private async dailyStandup(workspaceId: string): Promise<PromptResult> {
    const since = Date.now() - 24 * 60 * 60_000;
    const infos = this.deps.sessions.listInfo()
      .filter((i) => i.workspaceId === workspaceId && i.lastActivityAt >= since);
    const lines = infos.map((i) => `- ${i.shortAlias}: ${i.title ?? '(untitled)'} [${i.status.phase}]`);
    const body = `Yesterday's sessions in this workspace:\n${lines.join('\n') || '(none)'}\n\nProduce a 3-5 bullet standup draft.`;
    return { description: 'Daily standup draft', messages: [{ role: 'user', content: { type: 'text', text: body } }] };
  }

  private async reviewSession(alias: string): Promise<PromptResult> {
    const s = this.deps.sessions.getByPrefix(alias).resolved ?? this.deps.sessions.get(alias) ?? null;
    const info = s?.snapshot();
    const body = info
      ? `Review session ${info.shortAlias} (${info.title ?? 'untitled'}). Provide a 5-point critique covering scope, quality, cost.`
      : `Session alias "${alias}" not found.`;
    return { description: `Review ${alias}`, messages: [{ role: 'user', content: { type: 'text', text: body } }] };
  }

  private async crossSearch(query: string, workspaceId: string): Promise<PromptResult> {
    const infos = this.deps.sessions.listInfo().filter((i) => i.workspaceId === workspaceId);
    const hits = infos.filter((i) =>
      `${i.title ?? ''} ${i.shortAlias} ${i.workdir}`.toLowerCase().includes(query.toLowerCase()),
    );
    const lines = hits.map((h) => `- ${h.shortAlias} — ${h.title ?? ''}`);
    const body = `Query: "${query}"\n\nCandidate sessions:\n${lines.join('\n') || '(no hits)'}\n\nPick the most relevant and justify briefly.`;
    return { description: `Cross-search: ${query}`, messages: [{ role: 'user', content: { type: 'text', text: body } }] };
  }

  private async teamDigest(): Promise<PromptResult> {
    const wsInfos = this.deps.workspaces.list().map((ws) => {
      const n = this.deps.sessions.listInfo().filter((s) => s.workspaceId === ws.id).length;
      return `- ${ws.name} (${n} sessions)`;
    });
    const body = `Team workspaces:\n${wsInfos.join('\n')}\n\nProduce a 4-bullet team digest.`;
    return { description: 'Team digest', messages: [{ role: 'user', content: { type: 'text', text: body } }] };
  }

  private async explainError(eventId: string): Promise<PromptResult> {
    const body = `Event ID: ${eventId}\n\nExplain this error in plain English and suggest one next step.`;
    return { description: 'Explain error', messages: [{ role: 'user', content: { type: 'text', text: body } }] };
  }

  private async continuePlan(workspaceId: string): Promise<PromptResult> {
    const ws = this.deps.workspaces.get(workspaceId);
    const body = ws
      ? `Workspace: ${ws.name} (${ws.workdir})\n\nResume the active plan from ~/.tlive/workspaces/${ws.id}/memory/active-plan.json. What's the next step?`
      : 'Workspace not found. Cannot continue.';
    return { description: 'Continue plan', messages: [{ role: 'user', content: { type: 'text', text: body } }] };
  }
}
