// src/kernel/permission/notify-broker.ts

export interface NotifyBrokerDeps {
  workspaceForPid: (pid: number) => string | undefined;
  chatsForWorkspace: (wsId: string) => Array<{ channel: string; chatId: string }>;
  sendToChat: (target: { channel: string; chatId: string }, msg: { text: string; level: string }) => Promise<void>;
}

export class NotifyBroker {
  constructor(private opts: NotifyBrokerDeps) {}

  async push(req: { pid: number; message: string; level: string }): Promise<void> {
    const wsId = this.opts.workspaceForPid(req.pid);
    if (!wsId) return;
    const targets = this.opts.chatsForWorkspace(wsId);
    await Promise.all(targets.map((t) => this.opts.sendToChat(t, { text: req.message, level: req.level })));
  }
}
