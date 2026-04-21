// bridge/src/engine/ipc-session-handler.ts

import type { IPCServer } from '../../../src/ipc.js';
import type { SessionManager } from '../../../src/session/manager.js';
import type { PermissionBroker } from '../../../src/session/permission-broker.js';
import type { WorkspaceManager } from './workspace-manager.js';
import type { IPCRequest, IPCResponse, Envelope } from '../../../src/ipc-protocol.js';
import type { Socket } from 'node:net';

export class IPCSessionHandler {
  constructor(
    private readonly ipc: IPCServer,
    private readonly sessionManager: SessionManager,
    private readonly permissionBroker: PermissionBroker,
    private readonly workspaceManager: WorkspaceManager,
  ) {}

  start(): void {
    this.ipc.on('message', (msg: { type: string; payload: Record<string, unknown> }, socket: Socket) => {
      if (msg.type !== 'request') return;
      const envelope = msg.payload.envelope as Envelope<IPCRequest> | undefined;
      if (!envelope) return;
      void this.dispatch(envelope.message).then((reply) => {
        this.ipc.reply(socket, {
          type: 'response',
          payload: { envelope: { requestId: envelope.requestId, message: reply } } as Record<string, unknown>,
        });
      }).catch((err: Error) => {
        this.ipc.reply(socket, {
          type: 'response',
          payload: {
            envelope: {
              requestId: envelope.requestId,
              message: { type: 'error', payload: { message: err.message } },
            },
          } as Record<string, unknown>,
        });
      });
    });
  }

  private async dispatch(req: IPCRequest): Promise<IPCResponse> {
    switch (req.type) {
      case 'create_session': {
        const workspace = this.workspaceManager.ensureDefault({
          workdir: req.payload.workdir,
          runtime: req.payload.provider,
        });
        const session = await this.sessionManager.create({
          workspaceId: req.payload.workspaceId ?? workspace?.name ?? 'default',
          workspaceName: req.payload.workspaceName ?? workspace?.name,
          provider: req.payload.provider,
          workdir: req.payload.workdir,
          initialPrompt: req.payload.initialPrompt,
          model: req.payload.model,
          effort: req.payload.effort,
          source: 'cli',
        });
        return { type: 'session_created', payload: { sessionId: session.id } };
      }
      case 'send_input': {
        const s = this.sessionManager.get(req.payload.sessionId);
        if (!s) return { type: 'error', payload: { message: 'session not found' } };
        await s.sendInput(req.payload.text, 'cli');
        return { type: 'ack', payload: { ok: true } };
      }
      case 'stop_session': {
        await this.sessionManager.stop(req.payload.sessionId);
        return { type: 'ack', payload: { ok: true } };
      }
      case 'resume_session': {
        const s = await this.sessionManager.resume(req.payload.sessionId);
        return s
          ? { type: 'session_created', payload: { sessionId: s.id } }
          : { type: 'error', payload: { message: 'session not found' } };
      }
      case 'list_sessions': {
        return { type: 'session_list', payload: { sessions: this.sessionManager.list() } };
      }
      case 'resolve_permission': {
        const ok = this.permissionBroker.resolve(req.payload.permissionId, req.payload.decision);
        return ok
          ? { type: 'ack', payload: { ok: true } }
          : { type: 'error', payload: { message: 'permission id unknown' } };
      }
      case 'tail_history': {
        // CLI tail reads jsonl directly; daemon just acks.
        return { type: 'ack', payload: { ok: true } };
      }
    }
  }
}
