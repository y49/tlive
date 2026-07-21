import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapDaemon, shouldFastNullContinue, clampPermissionTimeout, makeCodexResumeHandler, shouldDropNotify, resolveKey, type DaemonHandle } from '../bootstrap';
import { request, daemonSocketPath } from '../../ipc/client';
import type { IMAdapter, IMChannel, OutgoingMessage, IncomingEnvelope } from '../../contracts/im-adapter';
import { SessionRegistry } from '../../web/session-registry';

let tmp: string;
let h: DaemonHandle;

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'tlive-d-')); });
afterEach(async () => { await h?.shutdown(); });

describe('daemon bootstrap', () => {
  it('starts and answers daemon.status', async () => {
    h = await bootstrapDaemon({ home: tmp });
    const r = await request({ kind: 'daemon.status' }, { socketPath: daemonSocketPath(tmp), timeoutMs: 2000 });
    expect(r.kind).toBe('daemon.status');
  });

  it('reports codex: off when the app-server custody cannot be established', async () => {
    h = await bootstrapDaemon({ home: tmp, ensureAppServer: async () => null });
    const r = await request({ kind: 'daemon.status' }, { socketPath: daemonSocketPath(tmp), timeoutMs: 2000 });
    expect(r).toMatchObject({ kind: 'daemon.status', codex: 'off' });
  });
});

describe('dual-channel wiring helpers', () => {
  it('continue fast-nulls only when neither IM nor web can answer', () => {
    expect(shouldFastNullContinue(0, 0)).toBe(true);
    expect(shouldFastNullContinue(1, 0)).toBe(false);
    expect(shouldFastNullContinue(0, 1)).toBe(false);
  });
  it('clamps permission timeout to 24h and defaults to 580s', () => {
    expect(clampPermissionTimeout(undefined)).toBe(580);
    expect(clampPermissionTimeout(86_000)).toBe(86_000);
    expect(clampPermissionTimeout(999_999)).toBe(86_400);
  });
});

describe('resolveKey — one key per session, not per directory', () => {
  it('prefers the wrapped run id (already unique)', () => {
    expect(resolveKey('sess-1', '/w', 'run-uuid')).toBe('run-uuid');
  });

  it('uses the session id so two sessions in ONE directory never collide', () => {
    expect(resolveKey('sess-A', '/same/dir')).toBe('sess-A');
    expect(resolveKey('sess-B', '/same/dir')).toBe('sess-B');
    expect(resolveKey('sess-A', '/same/dir')).not.toBe(resolveKey('sess-B', '/same/dir'));
  });

  it('falls back to cwd when the session id is missing (normalizer yields "")', () => {
    expect(resolveKey('', '/w')).toBe('/w');
  });
});

describe('shouldDropNotify', () => {
  it('drops an info-level idle notify when a continue card is already pending for the session', () => {
    expect(shouldDropNotify('req-1', 'info')).toBe(true);
  });
  it('never drops an error-level failure notify, even with a continue card pending — a stale continueId (up to continueWindowSec, default 30min) must not silently eat a tool/stop failure alert', () => {
    expect(shouldDropNotify('req-1', 'error')).toBe(false);
  });
  it('keeps the notify when no continue card is outstanding, for both levels', () => {
    expect(shouldDropNotify(null, 'info')).toBe(false);
    expect(shouldDropNotify(undefined, 'info')).toBe(false);
    expect(shouldDropNotify(null, 'error')).toBe(false);
    expect(shouldDropNotify(undefined, 'error')).toBe(false);
  });
});

describe('makeCodexResumeHandler', () => {
  function fakeEvents(size = 1) {
    const broadcast = (v: unknown) => broadcasts.push(v);
    const broadcasts: unknown[] = [];
    return { broadcast, size: () => size, broadcasts };
  }

  it('reply path: resume called and active broadcast', async () => {
    const sessions = new SessionRegistry();
    const events = fakeEvents(1);
    const resume = async (_t: string, _i: string) => undefined;
    let resumeCall: [string, string] | undefined;
    const handler = makeCodexResumeHandler({
      broker: { request: async () => 'go on' },
      sessions,
      events,
      chats: () => [],
      resume: async (t, i) => { resumeCall = [t, i]; await resume(t, i); },
    });
    handler({ threadId: 't1', key: 'codex:t1', lastMessage: 'done' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(resumeCall).toEqual(['t1', 'go on']);
    expect(events.broadcasts.some((b: any) => b.session?.status === 'active')).toBe(true);
  });

  it('fast-null path: no channel → idle broadcast, broker/resume never called', async () => {
    const sessions = new SessionRegistry();
    const events = fakeEvents(0);
    let requested = false;
    let resumed = false;
    const handler = makeCodexResumeHandler({
      broker: { request: async () => { requested = true; return 'x'; } },
      sessions,
      events,
      chats: () => [],
      resume: async () => { resumed = true; },
    });
    handler({ threadId: 't1', key: 'codex:t1' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(requested).toBe(false);
    expect(resumed).toBe(false);
    expect(events.broadcasts.some((b: any) => b.session?.status === 'idle')).toBe(true);
  });

  it('null-reply path: idle broadcast, resume not called', async () => {
    const sessions = new SessionRegistry();
    const events = fakeEvents(1);
    let resumed = false;
    const handler = makeCodexResumeHandler({
      broker: { request: async () => null },
      sessions,
      events,
      chats: () => [],
      resume: async () => { resumed = true; },
    });
    handler({ threadId: 't1', key: 'codex:t1' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(resumed).toBe(false);
    expect(events.broadcasts.filter((b: any) => b.session?.status === 'idle').length).toBeGreaterThan(0);
  });
});

describe('local-answer cancel + Stop fast-null (integration)', () => {
  function fakeAdapter(channel: IMChannel): IMAdapter {
    return {
      channel,
      async start() { /* noop */ },
      async stop() { /* noop */ },
      async send(_out: OutgoingMessage) { return { messageId: 'm1' }; },
      async edit() { /* noop */ },
      onInbound(_h: (e: IncomingEnvelope) => void) { /* noop */ },
      isConnected() { return 'connected' as const; },
    };
  }

  it('a PostToolUse activity for the same key+tool releases the pending approval as defer', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    h = await bootstrapDaemon({ home: tmp, imAdapters: [fakeAdapter('telegram')] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 100)); // let the card go pending
    await request(
      { kind: 'hook.event', event: { event: 'activity', cwd: '/w', sessionId: 's1', toolName: 'Bash', result: {} } },
      { socketPath: sock, timeoutMs: 2000 },
    );
    const r = await pending;
    expect(r).toEqual({ kind: 'hook.permission.result', decision: 'defer' });
  });

  it('hook.continue.request replies null immediately with no IM and no web clients', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    h = await bootstrapDaemon({ home: tmp });
    const t0 = Date.now();
    const r = await request(
      { kind: 'hook.continue.request', cwd: '/w', sessionId: 's1', context: 'done' },
      { socketPath: daemonSocketPath(tmp), timeoutMs: 5_000 },
    );
    expect(r).toEqual({ kind: 'hook.continue.result', reply: null });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

// Shared by every describe below that needs a fake IM channel capable of both
// sending/editing cards AND firing a simulated inbound reply (button tap or
// quoted-text reply) back through the daemon's onInbound wiring.
function interactiveAdapter(
  channel: IMChannel,
  sent: OutgoingMessage[],
  edits: Array<{ messageId: string; msg: OutgoingMessage }> = [],
): IMAdapter & { fire: (env: IncomingEnvelope) => void } {
  let handler: ((e: IncomingEnvelope) => void) | undefined;
  return {
    channel,
    async start() { /* noop */ },
    async stop() { /* noop */ },
    async send(out: OutgoingMessage) { sent.push(out); return { messageId: `m${sent.length}` }; },
    async edit(messageId, msg) { edits.push({ messageId, msg }); },
    onInbound(h) { handler = h; },
    isConnected() { return 'connected' as const; },
    fire(env) { handler?.(env); },
  };
}

describe('AskUserQuestion remote card (Task 9)', () => {
  it('sends option buttons (not Allow/Deny) and picking one answers deny+message with the selection', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'AskUserQuestion',
        input: { questions: [{ question: 'Pick a color?', options: [{ label: 'Red' }, { label: 'Blue' }] }] },
        timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 100)); // grace=0, let the card go out
    expect(sent).toHaveLength(1);
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    const ids = card.buttons?.map((b) => b.id) ?? [];
    expect(ids.filter((id) => id.startsWith('ask:')).length).toBe(2); // one per option
    expect(ids.some((id) => id.startsWith('askskip:'))).toBe(true);
    // NB: `toContain` uses ===, not an asymmetric-matcher-aware deep-equal — it
    // would silently accept `expect.stringMatching(...)` and never fail
    // (review Minor 3). `.some(...)` is the real check.
    expect(ids.some((id) => id.startsWith('approve:'))).toBe(false);

    const pickBlue = card.buttons!.find((b) => b.id.endsWith(':1'))!;
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: pickBlue.id, ts: 0 });

    const r = await pending as { kind: string; decision?: string; message?: string };
    expect(r.kind).toBe('hook.permission.result');
    expect(r.decision).toBe('deny');
    expect(r.message).toContain('Selected: Blue');
    expect(r.message).toContain('"Pick a color?": "Blue"');
  });

  it('Skip passes through with an allow decision and no message (local terminal answers)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'AskUserQuestion',
        input: { questions: [{ question: 'Pick a color?', options: [{ label: 'Red' }, { label: 'Blue' }] }] },
        timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 100));
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    const skipBtn = card.buttons!.find((b) => b.id.startsWith('askskip:'))!;
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: skipBtn.id, ts: 0 });

    const r = await pending as { kind: string; decision?: string; message?: string };
    expect(r).toEqual({ kind: 'hook.permission.result', decision: 'allow' });
  });

  it('picking an option edits the IM card to "Answered" — the wire is a deny, but the user picked an answer (review Minor 4)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
    const adapter = interactiveAdapter('telegram', sent, edits);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'AskUserQuestion',
        input: { questions: [{ question: 'Pick a color?', options: [{ label: 'Red' }, { label: 'Blue' }] }] },
        timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 100));
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    const pickBlue = card.buttons!.find((b) => b.id.endsWith(':1'))!;
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: pickBlue.id, ts: 0 });
    await pending;

    expect(edits).toHaveLength(1);
    const editedTitle = (edits[0].msg as { title?: string }).title ?? '';
    expect(editedTitle).toContain('Answered');
    expect(editedTitle).not.toContain('Denied');
  });

  it('fires ONE desktop notification when the approval card goes out (the at-the-computer pointer)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    const clears: number[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => { clears.push(1); } } });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'touch /x' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(notes).toHaveLength(1); // exactly once — not once per configured channel
    expect(notes[0].title).toContain('Bash');
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: card.buttons!.find((b) => b.id.startsWith('approve:'))!.id, ts: 0 });
    await pending;
    // Warp-style lifecycle: the answer resolved the LAST pending approval →
    // the desktop notification is actively cleared, never left as a zombie.
    expect(clears.length).toBeGreaterThan(0);
  });

  it('two configured chats with a slow adapter still get ONE desktop ping per request (regression: per-chat concurrent pushes each fired a toast)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] }, feishu: { appId: 'a', appSecret: 's', chatId: 'f1' } },
    }));
    const sent: OutgoingMessage[] = [];
    const tg = interactiveAdapter('telegram', sent);
    const fs = interactiveAdapter('feishu', sent);
    // Slow sends: both per-channel pushes are in flight past their await when
    // the first completes — the old post-send sentCards guard let both notify.
    for (const a of [tg, fs]) {
      const base = a.send.bind(a);
      a.send = async (out) => { await new Promise((r) => setTimeout(r, 20)); return base(out); };
    }
    const notes: Array<{ title: string; body: string }> = [];
    const clears: number[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [tg, fs], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => { clears.push(1); } } });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'touch /x' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(sent).toHaveLength(2); // one card per channel…
    expect(notes).toHaveLength(1); // …but a single desktop ping
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    tg.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: card.buttons!.find((b) => b.id.startsWith('approve:'))!.id, ts: 0 });
    await pending;
  });

  it('the settled card keeps its body — you can still see WHAT was approved (live feedback)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
    const adapter = interactiveAdapter('telegram', sent, edits);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash',
        input: { command: 'touch /tmp/probe', description: 'probe file' },
        timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 100));
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    const approveBtn = card.buttons!.find((b) => b.id.startsWith('approve:'))!;
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: approveBtn.id, ts: 0 });
    await pending;

    expect(edits).toHaveLength(1);
    const edited = edits[0].msg as { title?: string; body?: string; buttons?: unknown[] };
    expect(edited.title).toContain('Allowed');
    expect(edited.body).toContain('touch /tmp/probe');   // the command survives settlement
    expect(edited.buttons ?? []).toHaveLength(0);        // deactivation is button removal, not body erasure
  });

  it('deny-with-guidance writes the reason back onto the settled card', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
    const adapter = interactiveAdapter('telegram', sent, edits);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash',
        input: { command: 'rm -rf /tmp/x' },
        timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 100));
    const cardMsgId = 'm1'; // interactiveAdapter assigns sequential ids m1, m2, …
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x2', text: 'use mv to the scratchpad instead', replyToMessageId: cardMsgId, ts: 0 });
    const r = await pending as { decision?: string; message?: string };
    expect(r.decision).toBe('deny');

    expect(edits).toHaveLength(1);
    const edited = edits[0].msg as { title?: string; body?: string };
    expect(edited.title).toContain('Denied with guidance');
    expect(edited.body).toContain('rm -rf /tmp/x');                      // original command kept
    expect(edited.body).toContain('> use mv to the scratchpad instead'); // the reason, quoted
  });

  it('malformed AskUserQuestion input falls through to the normal approval card (Allow/Deny)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'AskUserQuestion', input: { questions: [] }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 100));
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    const ids = card.buttons?.map((b) => b.id) ?? [];
    expect(ids.some((id) => id.startsWith('approve:'))).toBe(true);
    expect(ids.some((id) => id.startsWith('deny:'))).toBe(true);
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: `deny:${ids[1].split(':')[1]}`, ts: 0 });
    await pending;
  });

  describe('multi-select (Task 10)', () => {
    function multiSelectConfig(): string {
      return JSON.stringify({
        web: { enabled: false },
        approvals: { approvalGraceSec: 0 },
        adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
      });
    }

    function fireMultiSelectRequest(sock: string) {
      return request(
        {
          kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'AskUserQuestion',
          input: { questions: [{ question: 'Pick colors?', multiSelect: true, options: [{ label: 'Red' }, { label: 'Blue' }] }] },
          timeoutSec: 60,
        },
        { socketPath: sock, timeoutMs: 10_000 },
      );
    }

    it('sends checkbox/Submit/Skip buttons instead of numbered single-pick buttons', async () => {
      writeFileSync(join(tmp, 'config.json'), multiSelectConfig());
      const sent: OutgoingMessage[] = [];
      const adapter = interactiveAdapter('telegram', sent);
      h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
      const sock = daemonSocketPath(tmp);
      const pending = fireMultiSelectRequest(sock);
      await new Promise((r) => setTimeout(r, 100));
      const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
      const ids = card.buttons?.map((b) => b.id) ?? [];
      expect(ids.filter((id) => id.startsWith('asktoggle:')).length).toBe(2); // one per option
      expect(ids.some((id) => id.startsWith('asksubmit:'))).toBe(true);
      expect(ids.some((id) => id.startsWith('askskip:'))).toBe(true);
      expect(ids.some((id) => id.startsWith('ask:'))).toBe(false); // not the single-select numbered form
      const checkboxLabels = card.buttons!.filter((b) => b.id.startsWith('asktoggle:')).map((b) => b.label);
      expect(checkboxLabels).toEqual(['▢ Red', '▢ Blue']);
      const submitBtn = card.buttons!.find((b) => b.id.startsWith('asksubmit:'))!;
      expect(submitBtn.label).toBe('Submit (0)');

      const skipBtn = card.buttons!.find((b) => b.id.startsWith('askskip:'))!;
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: skipBtn.id, ts: 0 });
      const r = await pending;
      expect(r).toEqual({ kind: 'hook.permission.result', decision: 'allow' });
    });

    it('toggling a checkbox edits the sent card with refreshed state and a live Submit(N) count', async () => {
      writeFileSync(join(tmp, 'config.json'), multiSelectConfig());
      const sent: OutgoingMessage[] = [];
      const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
      const adapter = interactiveAdapter('telegram', sent, edits);
      h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
      const sock = daemonSocketPath(tmp);
      const pending = fireMultiSelectRequest(sock);
      await new Promise((r) => setTimeout(r, 100));
      const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
      const toggleBlue = card.buttons!.find((b) => b.id.startsWith('asktoggle:') && b.id.endsWith(':1'))!;

      // Edits now go through the per-rid serial queue (Task 10 review Important
      // fix) — the edit lands on a later microtask, no longer synchronously
      // within fire(), so each assertion needs a tick to let the queue drain.
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: toggleBlue.id, ts: 0 });
      await new Promise((r) => setTimeout(r, 0));
      expect(edits).toHaveLength(1);
      const edited1 = edits[0].msg as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
      expect(edited1.buttons!.map((b) => b.label)).toEqual(['▢ Red', '▣ Blue', 'Submit (1)', 'Skip']);

      // toggling the same option again flips it back off
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: toggleBlue.id, ts: 0 });
      await new Promise((r) => setTimeout(r, 0));
      expect(edits).toHaveLength(2);
      const edited2 = edits[1].msg as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
      expect(edited2.buttons!.map((b) => b.label)).toEqual(['▢ Red', '▢ Blue', 'Submit (0)', 'Skip']);

      const skipBtn = card.buttons!.find((b) => b.id.startsWith('askskip:'))!;
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: skipBtn.id, ts: 0 });
      await pending;
    });

    it('Submit with nothing selected is a no-op — the request stays pending', async () => {
      writeFileSync(join(tmp, 'config.json'), multiSelectConfig());
      const sent: OutgoingMessage[] = [];
      const adapter = interactiveAdapter('telegram', sent);
      h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
      const sock = daemonSocketPath(tmp);
      const pending = fireMultiSelectRequest(sock);
      await new Promise((r) => setTimeout(r, 100));
      const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
      const answerSpy = vi.spyOn(h.permissionRouter, 'answer');
      const submitBtn = card.buttons!.find((b) => b.id.startsWith('asksubmit:'))!;
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: submitBtn.id, ts: 0 });
      expect(answerSpy).not.toHaveBeenCalled();

      // wrap up so the pending IPC call resolves
      const skipBtn = card.buttons!.find((b) => b.id.startsWith('askskip:'))!;
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: skipBtn.id, ts: 0 });
      await pending;
    });

    it('toggle-then-submit race: a slow toggle edit landing after the fast settlement edit must not resurrect the checkbox layout (Important bug repro)', async () => {
      writeFileSync(join(tmp, 'config.json'), multiSelectConfig());
      const sent: OutgoingMessage[] = [];
      const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
      // edit() is a real network call in production — nothing guarantees "later
      // dispatched → later landed". Here the toggle edit (carries `buttons`) is
      // deliberately made SLOWER than the settlement edit from onResolved (no
      // `buttons`), reproducing the exact reordering the bug report describes —
      // regardless of which one was actually *dispatched* first.
      let handler: ((e: IncomingEnvelope) => void) | undefined;
      const adapter: IMAdapter & { fire: (env: IncomingEnvelope) => void } = {
        channel: 'telegram',
        async start() { /* noop */ },
        async stop() { /* noop */ },
        async send(out: OutgoingMessage) { sent.push(out); return { messageId: `m${sent.length}` }; },
        async edit(messageId: string, msg: OutgoingMessage) {
          const hasButtons = Boolean((msg as { buttons?: unknown }).buttons);
          await new Promise((r) => setTimeout(r, hasButtons ? 50 : 5));
          edits.push({ messageId, msg });
        },
        onInbound(h) { handler = h; },
        isConnected() { return 'connected' as const; },
        fire(env) { handler?.(env); },
      };
      h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
      const sock = daemonSocketPath(tmp);
      const pending = fireMultiSelectRequest(sock);
      await new Promise((r) => setTimeout(r, 100));
      const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
      const toggleRed = card.buttons!.find((b) => b.id.startsWith('asktoggle:') && b.id.endsWith(':0'))!;
      const submitBtn = card.buttons!.find((b) => b.id.startsWith('asksubmit:'))!;

      // Toggle, then Submit — back to back, synchronously, mirroring "quickly
      // tap a checkbox then Submit" from the bug report.
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: toggleRed.id, ts: 0 });
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: submitBtn.id, ts: 0 });

      const r = await pending as { kind: string; decision?: string; message?: string };
      expect(r.decision).toBe('deny');

      // Let both artificially-delayed edits land (serialized: ~50ms + ~5ms with the fix).
      await new Promise((r2) => setTimeout(r2, 150));

      expect(edits.length).toBe(2);
      const last = edits.at(-1)!;
      const lastMsg = last.msg as { title?: string; buttons?: unknown };
      // The settlement edit (from onResolved) must be the one that lands LAST —
      // "no zombie cards": the final state must be the answered card, not the
      // reverted checkbox layout.
      expect(lastMsg.title).toContain('Answered');
      expect(lastMsg.buttons).toBeUndefined();
    });

    it('dual-channel race: a slow channel\'s in-flight toggle loop must not let a fast channel\'s settlement land, then get overwritten by a late toggle edit (multi-channel review Important repro)', async () => {
      // Reproduces the review's multi-channel finding: `asktoggle:`'s edit
      // loop used to `await` each card's queueEdit one at a time. With TWO
      // configured channels (Telegram + Feishu, the onboarding-doc default),
      // a slow channel 1 (telegram) keeps that loop suspended on its own
      // `await` before it ever reaches channel 2 (feishu)'s card. Meanwhile
      // Submit arrives (a SEPARATE inbound message) and onResolved's
      // settlement loop enqueues BOTH channels' settlement edits
      // synchronously, in one tick — including feishu's, which the toggle
      // loop hasn't gotten to yet. Once the toggle loop finally resumes and
      // enqueues feishu's toggle edit, it lands behind the already-enqueued
      // feishu settlement edit → feishu's card reverts to the checkbox
      // layout even though it "answered" first. Fixed by mirroring
      // onResolved's own pattern: enqueue every card's edit synchronously,
      // no per-card await.
      writeFileSync(join(tmp, 'config.json'), JSON.stringify({
        web: { enabled: false },
        approvals: { approvalGraceSec: 0 },
        adapters: {
          telegram: { token: 't', chatIdAllowList: ['c1'] },
          feishu: { appId: 'a', appSecret: 's', chatId: 'c2' },
        },
      }));
      function delayedChannelAdapter(
        channel: IMChannel,
        delayMs: number,
        sent: OutgoingMessage[],
        edits: Array<{ channel: IMChannel; messageId: string; msg: OutgoingMessage }>,
      ): IMAdapter & { fire: (env: IncomingEnvelope) => void } {
        let handler: ((e: IncomingEnvelope) => void) | undefined;
        return {
          channel,
          async start() { /* noop */ },
          async stop() { /* noop */ },
          async send(out: OutgoingMessage) { sent.push(out); return { messageId: `${channel}-m${sent.length}` }; },
          async edit(messageId: string, msg: OutgoingMessage) {
            await new Promise((r) => setTimeout(r, delayMs));
            edits.push({ channel, messageId, msg });
          },
          onInbound(h) { handler = h; },
          isConnected() { return 'connected' as const; },
          fire(env) { handler?.(env); },
        };
      }
      const sentTg: OutgoingMessage[] = [];
      const sentFs: OutgoingMessage[] = [];
      const edits: Array<{ channel: IMChannel; messageId: string; msg: OutgoingMessage }> = [];
      const tg = delayedChannelAdapter('telegram', 80, sentTg, edits); // channel 1: slow
      const fs = delayedChannelAdapter('feishu', 5, sentFs, edits); // channel 2: fast
      h = await bootstrapDaemon({ home: tmp, imAdapters: [tg, fs] });
      const sock = daemonSocketPath(tmp);
      const pending = fireMultiSelectRequest(sock);
      await new Promise((r) => setTimeout(r, 100)); // grace=0, let both cards go out
      expect(sentTg).toHaveLength(1);
      expect(sentFs).toHaveLength(1);
      const card = sentTg[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
      const toggleRed = card.buttons!.find((b) => b.id.startsWith('asktoggle:') && b.id.endsWith(':0'))!;
      const submitBtn = card.buttons!.find((b) => b.id.startsWith('asksubmit:'))!;

      // Tap a checkbox then Submit, back to back on the SAME chat client
      // (telegram) — mirrors real usage: the user only ever interacts via
      // one channel, but both channels' cards must still settle correctly.
      tg.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: toggleRed.id, ts: 0 });
      tg.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: submitBtn.id, ts: 0 });

      const r = await pending as { kind: string; decision?: string };
      expect(r.decision).toBe('deny');

      // Let both artificially-delayed channels' edits fully land (serialized
      // per-rid: worst case is well under 80ms*2 + 5ms*2).
      await new Promise((r2) => setTimeout(r2, 300));

      const fsEdits = edits.filter((e) => e.channel === 'feishu');
      const last = fsEdits.at(-1)!;
      const lastMsg = last.msg as { title?: string; buttons?: unknown };
      // "no zombie cards": feishu's card must end up on the settled/Answered
      // state too, not reverted to the checkbox layout by a late toggle edit.
      expect(lastMsg.title).toContain('Answered');
      expect(lastMsg.buttons).toBeUndefined();
    });

    it('Submit with picks answers deny+message carrying every selected label, and edits the card to Answered', async () => {
      writeFileSync(join(tmp, 'config.json'), multiSelectConfig());
      const sent: OutgoingMessage[] = [];
      const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
      const adapter = interactiveAdapter('telegram', sent, edits);
      h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
      const sock = daemonSocketPath(tmp);
      const pending = fireMultiSelectRequest(sock);
      await new Promise((r) => setTimeout(r, 100));
      const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
      const toggleRed = card.buttons!.find((b) => b.id.startsWith('asktoggle:') && b.id.endsWith(':0'))!;
      const toggleBlue = card.buttons!.find((b) => b.id.startsWith('asktoggle:') && b.id.endsWith(':1'))!;
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: toggleRed.id, ts: 0 });
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: toggleBlue.id, ts: 0 });
      const submitBtn = card.buttons!.find((b) => b.id.startsWith('asksubmit:'))!;
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: submitBtn.id, ts: 0 });

      const r = await pending as { kind: string; decision?: string; message?: string };
      expect(r.decision).toBe('deny');
      expect(r.message).toContain('Selected: Red, Blue');

      const lastEdit = edits.at(-1)!;
      const title = (lastEdit.msg as { title?: string }).title ?? '';
      expect(title).toContain('Answered');
      expect(title).not.toContain('Denied');
    });
  });
});

describe('quoting a live approval card = deny with guidance (Task 7)', () => {
  it('routes the quoted reply to the pending permission request as a deny+message, and rewrites the card "Denied with guidance"', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
    const adapter = interactiveAdapter('telegram', sent, edits);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'rm -rf /tmp/x' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 100)); // let the card go pending + send
    expect(sent).toHaveLength(1); // sanity: the card really was sent, its messageId is `m1`
    adapter.fire({
      channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1',
      replyToMessageId: 'm1', text: 'Do not use rm -rf, move it to /tmp/.trash instead', ts: 0,
    });

    const r = await pending as { kind: string; decision?: string; message?: string };
    expect(r.decision).toBe('deny');
    expect(r.message).toBe('Do not use rm -rf, move it to /tmp/.trash instead');

    await new Promise((res) => setTimeout(res, 50)); // let the queued settlement edit land
    expect(edits).toHaveLength(1);
    const editedTitle = (edits[0].msg as { title?: string }).title ?? '';
    expect(editedTitle).toContain('Denied with guidance');
  });

  it('a plain button Deny (no quoted text) still edits the card to the bare "Denied" — guidance label only when a message rode along', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
    const adapter = interactiveAdapter('telegram', sent, edits);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'rm -rf /tmp/x' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 100));
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    const denyBtn = card.buttons!.find((b) => b.id.startsWith('deny:'))!;
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: denyBtn.id, ts: 0 });
    await pending;

    await new Promise((res) => setTimeout(res, 50));
    expect(edits).toHaveLength(1);
    const editedTitle = (edits[0].msg as { title?: string }).title ?? '';
    expect(editedTitle).toContain('Denied');
    expect(editedTitle).not.toContain('Denied with guidance');
  });
});

// Regression: the Codex resume path (makeCodexResumeHandler → ContinueBroker →
// continueBroker.onRequest wired in bootstrapDaemon) used to default the
// continue-request `context` to the bare string 'Turn finished', while the
// card-body-emptying check in bootstrap.ts compared against the longer
// 'Turn finished — reply to continue' sentinel that only the CC (normalizer.ts
// stop event) path actually produces. The two hardcoded literals drifted, so
// on Codex with no lastMessage the emptying check never matched and the card
// body quoted 'Turn finished' right under a 'Turn finished' title.
describe('Codex resume handler → continue card (regression: sentinel mismatch)', () => {
  function recordingAdapter(channel: IMChannel, sent: OutgoingMessage[]): IMAdapter {
    return {
      channel,
      async start() { /* noop */ },
      async stop() { /* noop */ },
      async send(out: OutgoingMessage) { sent.push(out); return { messageId: 'm1' }; },
      async edit() { /* noop */ },
      onInbound(_h: (e: IncomingEnvelope) => void) { /* noop */ },
      isConnected() { return 'connected' as const; },
    };
  }

  it('renders an empty continue-card body (no duplicated title) when Codex has no lastMessage', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [recordingAdapter('telegram', sent)] });

    // Mirrors exactly how bootstrapDaemon wires makeCodexResumeHandler: same
    // (real, shared) continueBroker instance whose onRequest handler is the
    // one that builds the IM card.
    const onCodexResumePrompt = makeCodexResumeHandler({
      broker: h.continueBroker,
      sessions: h.sessions,
      events: h.events,
      chats: () => [{}], // non-empty → bypasses the fast-null path
      resume: async () => undefined,
    });

    onCodexResumePrompt({ threadId: 't1', key: 'codex:t1' }); // no lastMessage
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(sent).toHaveLength(1);
    const card = sent[0] as { kind: 'card'; title?: string; body?: string };
    // Title carries the usual `<label> · ` session tag (unrelated to this bug);
    // what matters here is that the body is NOT a quoted repeat of the title.
    expect(card.title?.endsWith('Turn finished')).toBe(true);
    expect(card.body).toBe('\n*Reply to continue*');
  });
});
