import { describe, it, expect } from 'vitest';
import { decorateEvent, isScannerPathNotification } from '../engine/terminal-context-decorator.js';
import type { NotificationEvent } from '../renderers/types.js';
import type { ScannerContextSnapshot, NotificationPayload } from '../engine/notification-dispatcher.js';

const ctx: ScannerContextSnapshot = {
  sessionId: 'abcdef12-3456',
  workdir: '/home/alice/foo',
  workspaceName: 'foo',
  provider: 'claude',
  terminalUrl: 'http://host/?token=t',
  isLocal: true,
};

describe('decorateEvent', () => {
  it('activity_text: injects title + terminalUrl when missing', () => {
    const e: NotificationEvent = { kind: 'activity_text', text: 'hi' };
    const out = decorateEvent(e, ctx);
    expect(out).toMatchObject({
      kind: 'activity_text',
      text: 'hi',
      title: expect.stringMatching(/Terminal · foo · #abcdef · local/),
      terminalUrl: 'http://host/?token=t',
    });
  });

  it('activity_text: preserves existing title/terminalUrl', () => {
    const e: NotificationEvent = { kind: 'activity_text', text: 'hi', title: 'Preset', terminalUrl: 'http://other/' };
    const out = decorateEvent(e, ctx);
    expect(out).toMatchObject({ title: 'Preset', terminalUrl: 'http://other/' });
  });

  it('activity_tool: injects terminalUrl when missing', () => {
    const e: NotificationEvent = { kind: 'activity_tool', toolName: 'Bash', toolInput: 'ls' };
    const out = decorateEvent(e, ctx);
    expect(out).toMatchObject({ kind: 'activity_tool', terminalUrl: 'http://host/?token=t' });
  });

  it('activity_tool: preserves existing terminalUrl', () => {
    const e: NotificationEvent = { kind: 'activity_tool', toolName: 'Bash', toolInput: 'ls', terminalUrl: 'http://other/' };
    expect(decorateEvent(e, ctx)).toMatchObject({ terminalUrl: 'http://other/' });
  });

  it('session_complete: injects resumeHint and terminalUrl', () => {
    const e: NotificationEvent = { kind: 'session_complete', summary: 'done' };
    const out = decorateEvent(e, ctx);
    expect(out).toMatchObject({
      summary: 'done',
      resumeHint: expect.stringContaining('claude resume abcdef12-3456'),
      terminalUrl: 'http://host/?token=t',
    });
  });

  it('session_complete: preserves existing resumeHint and terminalUrl', () => {
    const e: NotificationEvent = { kind: 'session_complete', summary: 'done', resumeHint: 'preset', terminalUrl: 'http://other/' };
    expect(decorateEvent(e, ctx)).toMatchObject({ resumeHint: 'preset', terminalUrl: 'http://other/' });
  });

  it('ask_user_question: passthrough (no context needed)', () => {
    const e: NotificationEvent = { kind: 'ask_user_question', question: 'Q', toolUseId: 'x' };
    expect(decorateEvent(e, ctx)).toEqual(e);
  });

  it('permission_request: passthrough', () => {
    const e: NotificationEvent = { kind: 'permission_request', toolName: 'Bash', toolInput: 'ls', permissionId: 'p1' };
    expect(decorateEvent(e, ctx)).toEqual(e);
  });

  it('todo_update / thinking / reasoning_summary / file_change_list / error: passthrough', () => {
    const events: NotificationEvent[] = [
      { kind: 'todo_update', items: [] },
      { kind: 'thinking', active: true },
      { kind: 'reasoning_summary', text: 'r' },
      { kind: 'file_change_list', changes: [], status: 'completed' },
      { kind: 'error', message: 'err' },
    ];
    for (const e of events) expect(decorateEvent(e, ctx)).toEqual(e);
  });
});

describe('isScannerPathNotification', () => {
  it('returns true when sessionCtx has isLocal: true', () => {
    const n: NotificationPayload = {
      text: 'x',
      sessionCtx: ctx,
    };
    expect(isScannerPathNotification(n)).toBe(true);
  });

  it('returns false when sessionCtx is undefined', () => {
    const n: NotificationPayload = { text: 'x' };
    expect(isScannerPathNotification(n)).toBe(false);
  });
});
