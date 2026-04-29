// tests/im/multi-binding.test.ts
//
// CRITICAL regression guard for T6 review fix #1 — the N×M fan-out bug.
// Before the fix: renderers iterated session.targets internally while
// SessionFrontend also iterated channels, producing N×M calls often sent
// through the wrong adapter (Telegram seeing Discord chatId).
//
// After the fix (renderer-per-target): each adapter sees exactly one call
// per event, scoped to its own chatId, with interactive buttons only on
// the primary binding.

import { describe, it, expect } from 'vitest';
import { SessionFrontend } from '../../src/im/frontend.js';
import type { PermissionBroker, BrokerListener } from '../../src/permission/broker.js';
import type { WorkspaceManager } from '../../src/workspace/manager.js';
import { FakeAdapter } from './fake-adapter.js';
import { FakeSession, mkFakeSessionManager } from './fake-session.js';

function mkPb(): PermissionBroker & { push: BrokerListener } {
  const listeners = new Set<BrokerListener>();
  return {
    subscribe(l: BrokerListener) { listeners.add(l); return () => listeners.delete(l); },
    push(ev: Parameters<BrokerListener>[0]) { for (const l of listeners) l(ev); },
  } as unknown as PermissionBroker & { push: BrokerListener };
}

function mkWm(): WorkspaceManager {
  return {
    partitionBindings(_: string) {
      return {
        primary: { channelType: 'telegram' as const, chatId: 'tg-100', role: 'primary' as const },
        mirrors: [{ channelType: 'discord' as const, chatId: 'ds-200', role: 'mirror' as const }],
        all: [
          { channelType: 'telegram' as const, chatId: 'tg-100', role: 'primary' as const },
          { channelType: 'discord' as const, chatId: 'ds-200', role: 'mirror' as const },
        ],
      };
    },
    get(_: string) { return { name: 'ws', defaults: { model: 'claude' } }; },
  } as unknown as WorkspaceManager;
}

async function tick(ms = 10) { await new Promise((r) => setTimeout(r, ms)); }

describe('multi-binding fan-out (T6 review #1)', () => {
  it('each adapter receives its own chatId only; no cross-sends', async () => {
    const tg = new FakeAdapter('telegram');
    const ds = new FakeAdapter('discord');
    const sm = mkFakeSessionManager();
    const pb = mkPb();
    const frontend = new SessionFrontend({
      sessionManager: sm, workspaceManager: mkWm(), permissionBroker: pb,
      adapters: { telegram: tg, discord: ds },
    });
    frontend.start();

    const session = new FakeSession({ id: 'sess-mb', workspaceId: 'w1' });
    sm.push({ kind: 'created', session });
    await tick();

    // No sends on session attach (legacy session-header renderer removed in T10b).
    expect(tg.byKind('send').length).toBe(0);
    expect(ds.byKind('send').length).toBe(0);

    // Drive a turn — turn_start sends HUD to primary (Telegram); mirror (Discord)
    // gets a reply echo on assistant_text but no HUD (primary-only).
    session.emit({ kind: 'turn_start', turnId: 't1', userInputPreview: 'hi', at: 1_000_000 });
    await tick();
    session.emit({ kind: 'assistant_text', turnId: 't1', text: 'hello', complete: true });
    await tick();
    session.emit({ kind: 'turn_end', turnId: 't1', durationMs: 100, costUsd: 0.05, tokensIn: 0, tokensOut: 0 });
    await tick(400); // wait past TurnUI turn_end 400ms reaction buffer

    // Each adapter must have received AT LEAST one send (HUD for Telegram,
    // reply-echo for Discord), all scoped to the correct chatId.
    expect(tg.byKind('send').length).toBeGreaterThan(0);
    expect(ds.byKind('send').length).toBeGreaterThan(0);
    for (const c of tg.calls) {
      if ('chatId' in (c.args as Record<string, unknown>)) {
        expect(String(c.args.chatId ?? 'tg-100')).toBe('tg-100');
      }
    }
    for (const c of ds.calls) {
      if ('chatId' in (c.args as Record<string, unknown>)) {
        expect(String(c.args.chatId ?? 'ds-200')).toBe('ds-200');
      }
    }

    // Cost accumulation: HUD edit on turn_end must include $0.05.
    const tgEdits = tg.byKind('edit');
    const costShown = tgEdits.some((e) => String(e.args.text ?? '').includes('$0.05'));
    expect(costShown).toBe(true);

    await frontend.stop();
  });

  it('permission card: only primary gets interactive card; mirror receives nothing (new UX)', async () => {
    const tg = new FakeAdapter('telegram');
    const ds = new FakeAdapter('discord');
    const sm = mkFakeSessionManager();
    const pb = mkPb();
    const frontend = new SessionFrontend({
      sessionManager: sm, workspaceManager: mkWm(), permissionBroker: pb,
      adapters: { telegram: tg, discord: ds },
    });
    frontend.start();

    const session = new FakeSession({ id: 'sess-mb2', workspaceId: 'w1' });
    sm.push({ kind: 'created', session });
    await tick();

    pb.push({
      kind: 'pending',
      sessionId: 'sess-mb2',
      request: {
        id: 'sess-mb2:p1', category: 'generic', toolName: 'X', toolInput: {},
        resolve: () => { /* noop */ },
      },
    });
    await tick();

    // Primary (Telegram) receives exactly one permission card send with buttons.
    const tgPermSends = tg.byKind('send').filter((c) => String(c.args.text ?? '').includes('Permission'));
    expect(tgPermSends).toHaveLength(1);
    const tgMarkup = tgPermSends[0]!.args.replyMarkup as { buttons?: unknown[][] } | undefined;
    expect(tgMarkup).toBeDefined();
    expect((tgMarkup!.buttons ?? []).length).toBeGreaterThan(0);

    // Mirror (Discord) receives no permission card in the new UX path —
    // only primaries get interactive cards (T10b: legacy mirror-tail renderer removed).
    const dsPermSends = ds.byKind('send').filter((c) => String(c.args.text ?? '').includes('Permission'));
    expect(dsPermSends).toHaveLength(0);

    await frontend.stop();
  });
});
