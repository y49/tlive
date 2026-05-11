// src/kernel/workspace/chat-router.ts

import type { IncomingEnvelope, IMChannel } from '../contracts/im-adapter.js';

export interface AllowedSender {
  channel: IMChannel;
  userId: string;
}

export type RouteResult =
  | { kind: 'route'; workspaceId: string }
  | { kind: 'unbound'; chatKey: string }
  | { kind: 'drop'; reason: 'unauthorized-sender' };

export interface ChatRouterOpts {
  bindings: Record<string, string>; // "channel:chatId" → workspaceId
  allowedSenders: AllowedSender[];
}

const senderKey = (channel: IMChannel, userId: string) => `${channel}:${userId}`;
const chatKey = (channel: IMChannel, chatId: string) => `${channel}:${chatId}`;

export class ChatRouter {
  private bindings: Map<string, string>;
  private allowed: Set<string>;

  constructor(opts: ChatRouterOpts) {
    this.bindings = new Map(Object.entries(opts.bindings));
    this.allowed = new Set(opts.allowedSenders.map((s) => senderKey(s.channel, s.userId)));
  }

  route(env: IncomingEnvelope): RouteResult {
    if (!this.allowed.has(senderKey(env.channel, env.userId))) {
      return { kind: 'drop', reason: 'unauthorized-sender' };
    }
    const ck = chatKey(env.channel, env.chatId);
    const ws = this.bindings.get(ck);
    if (!ws) return { kind: 'unbound', chatKey: ck };
    return { kind: 'route', workspaceId: ws };
  }

  bind(channel: IMChannel, chatId: string, workspaceId: string): void {
    this.bindings.set(chatKey(channel, chatId), workspaceId);
  }

  /** Snapshot for persistence. */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.bindings);
  }
}
