import { describe, it, expect } from 'vitest';
import { parseImCommand } from '../im-commands';

describe('parseImCommand (mute/help/trust/safe)', () => {
  it('recognizes /mute on|off — on = muted (quiet), off = notifications on', () => {
    expect(parseImCommand('/mute on')).toEqual({ kind: 'mute', muted: true });
    expect(parseImCommand('/mute off')).toEqual({ kind: 'mute', muted: false });
  });
  it('bare /mute (menu tap) or a bad arg → toggle-prompt (offer on/off buttons, not "unknown")', () => {
    expect(parseImCommand('/mute')).toEqual({ kind: 'toggle-prompt', which: 'mute' });
    expect(parseImCommand('/mute maybe')).toEqual({ kind: 'toggle-prompt', which: 'mute' });
  });
  it('strips @botname (Telegram group menus send /mute@bot)', () => {
    expect(parseImCommand('/mute@tlive_bot on')).toEqual({ kind: 'mute', muted: true });
    expect(parseImCommand('/mute@tlive_bot')).toEqual({ kind: 'toggle-prompt', which: 'mute' });
    expect(parseImCommand('/help@tlive_bot')).toEqual({ kind: 'help' });
  });
  it('/perm is retired (renamed to /mute) → unknown', () => {
    expect(parseImCommand('/perm on')).toEqual({ kind: 'unknown', name: 'perm' });
  });
  it('recognizes /help', () => {
    expect(parseImCommand('/help')).toEqual({ kind: 'help' });
  });
  it('returns null for non-command text', () => {
    expect(parseImCommand('hello there')).toBeNull();
  });
  it('unknown slash command → unknown kind', () => {
    expect(parseImCommand('/use ws-foo')).toEqual({ kind: 'unknown', name: 'use' });
    expect(parseImCommand('/unknown')).toEqual({ kind: 'unknown', name: 'unknown' });
  });
  it('parses /trust on|off', () => {
    expect(parseImCommand('/trust on')).toEqual({ kind: 'trust', enabled: true });
    expect(parseImCommand('/trust off')).toEqual({ kind: 'trust', enabled: false });
    expect(parseImCommand('/trust')).toEqual({ kind: 'toggle-prompt', which: 'trust' });
  });
  it('parses /safe on|off', () => {
    expect(parseImCommand('/safe on')).toEqual({ kind: 'safe', enabled: true });
    expect(parseImCommand('/safe off')).toEqual({ kind: 'safe', enabled: false });
    expect(parseImCommand('/safe')).toEqual({ kind: 'toggle-prompt', which: 'safe' });
  });
  it('/desktop is NOT an IM command — the toast is a machine-local control (CLI `tlive desktop` only)', () => {
    expect(parseImCommand('/desktop on')).toEqual({ kind: 'unknown', name: 'desktop' });
    expect(parseImCommand('/desktop off')).toEqual({ kind: 'unknown', name: 'desktop' });
  });
});
