//
// Authorization for inbound IM control (button callbacks, commands).
// Replaces ChatRouter's sender check. Single-user model:
// empty allowedSenders ⇒ allow all (trust the configured private chat).

import type { IMChannel } from '../contracts/im-adapter.js';

export interface AllowedSender {
  channel: IMChannel;
  userId: string;
}

export class SenderGuard {
  /** null ⇒ allow-all (no allowlist configured). */
  private readonly allowed: Set<string> | null;

  constructor(allowedSenders: AllowedSender[]) {
    this.allowed =
      allowedSenders.length === 0
        ? null
        : new Set(allowedSenders.map((s) => `${s.channel}:${s.userId}`));
  }

  allows(channel: IMChannel, userId: string): boolean {
    return this.allowed === null || this.allowed.has(`${channel}:${userId}`);
  }
}
