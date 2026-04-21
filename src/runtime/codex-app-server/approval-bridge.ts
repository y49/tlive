import type { CodexAppServerClient } from './client.js';
import type { CodexEventAdapter } from './event-adapter.js';

type PermissionDecision = 'allow' | 'deny' | 'allow_always';
type PermissionRequestHandler = (
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
) => Promise<PermissionDecision>;

const CLAUDE_TO_EXEC_FILE = {
  allow: 'accept' as const,
  allow_always: 'acceptForSession' as const,
  deny: 'decline' as const,
};

export class CodexApprovalBridge {
  constructor(
    private client: CodexAppServerClient,
    private eventAdapter: CodexEventAdapter,
    private onPermissionRequest: PermissionRequestHandler | undefined,
  ) {}

  wireHandlers(): void {
    this.client.onCommandExecutionApproval((p) => this.handleCommandExec(p));
    this.client.onFileChangeApproval((p) => this.handleFileChange(p));
    this.client.onPermissionsApproval((p) => this.handlePermissions(p));
    this.client.onMcpElicitation((p) => this.handleMcpElicitation(p));
  }

  private async handleCommandExec(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    if (!this.onPermissionRequest) return { decision: 'accept' };
    const input = { command: p.command ?? '', cwd: p.cwd ?? '' };
    const reason = (p.reason as string) ?? (p.command as string) ?? 'Codex command execution';
    try {
      const decision = await this.onPermissionRequest('Bash', input as Record<string, unknown>, reason);
      return { decision: CLAUDE_TO_EXEC_FILE[decision] };
    } catch (err) {
      console.warn(`[codex-approval-bridge] commandExecution broker error, declining: ${(err as Error).message}`);
      return { decision: 'decline' };
    }
  }

  private async handleFileChange(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    if (!this.onPermissionRequest) return { decision: 'accept' };
    const itemId = p.itemId as string | undefined;
    const cached = itemId ? this.eventAdapter.getItem(itemId) : undefined;
    const changes = (cached?.changes as unknown) ?? [];
    const input = { changes };
    const reason = (p.reason as string) ?? 'Codex file change';
    try {
      const decision = await this.onPermissionRequest('Edit', input as Record<string, unknown>, reason);
      return { decision: CLAUDE_TO_EXEC_FILE[decision] };
    } catch (err) {
      console.warn(`[codex-approval-bridge] fileChange broker error, declining: ${(err as Error).message}`);
      return { decision: 'decline' };
    }
  }

  private async handlePermissions(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    const permissionsReq = (p.permissions ?? {}) as Record<string, unknown>;
    if (!this.onPermissionRequest) {
      return { permissions: permissionsReq, scope: 'turn' };
    }
    const reason = (p.reason as string) ?? 'Codex requests additional permissions';
    try {
      const decision = await this.onPermissionRequest(
        'Permissions',
        permissionsReq,
        reason,
      );
      if (decision === 'deny') {
        return { permissions: {}, scope: 'turn' };
      }
      return {
        permissions: permissionsReq,
        scope: decision === 'allow_always' ? 'session' : 'turn',
      };
    } catch (err) {
      console.warn(`[codex-approval-bridge] permissions broker error, declining: ${(err as Error).message}`);
      return { permissions: {}, scope: 'turn' };
    }
  }

  private async handleMcpElicitation(_params: unknown): Promise<unknown> {
    console.warn('[codex-approval-bridge] MCP elicitation received — auto-declining (not supported in v1.1)');
    return { action: 'decline', content: null };
  }
}
