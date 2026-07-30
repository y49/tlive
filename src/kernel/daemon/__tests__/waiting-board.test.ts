import { describe, it, expect } from 'vitest';
import { WaitingBoard, renderBoard, type WaitingEntry } from '../waiting-board.js';

const entry = (over: Partial<WaitingEntry> = {}): WaitingEntry => ({
  id: 'r1', key: '/w/proj', label: 'proj', kind: 'held', what: 'Bash', ...over,
});

describe('WaitingBoard', () => {
  it('is empty until something is registered, and empty again once retired', () => {
    const b = new WaitingBoard();
    expect(b.isEmpty()).toBe(true);
    b.add(entry());
    expect(b.isEmpty()).toBe(false);
    expect(b.remove('r1')).toBe(true);
    expect(b.isEmpty()).toBe(true);
  });

  it('retiring an id that was never registered is a no-op, not a throw', () => {
    const b = new WaitingBoard();
    expect(b.remove('nope')).toBe(false);
  });

  it('re-adding the same id replaces rather than duplicates (one dialog, one line)', () => {
    const b = new WaitingBoard();
    b.add(entry({ what: 'Bash' }));
    b.add(entry({ what: 'Read' }));
    expect(b.size()).toBe(1);
    expect(b.entries()[0]!.what).toBe('Read');
  });

  it('keeps registration order so the toast does not reshuffle between renders', () => {
    const b = new WaitingBoard();
    b.add(entry({ id: 'a', label: 'one' }));
    b.add(entry({ id: 'b', label: 'two' }));
    b.add(entry({ id: 'a', label: 'one', what: 'Edit' })); // replace in place
    expect(b.entries().map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('renderBoard', () => {
  it('renders nothing for an empty board — the caller clears instead', () => {
    expect(renderBoard([])).toBeNull();
  });

  it('a lone held approval names the session and the tool, and points at the dashboard', () => {
    expect(renderBoard([entry()])).toEqual({
      title: 'proj · Bash',
      body: 'Approval needed — click to open and answer',
    });
  });

  it('a lone terminal-only dialog says where to answer instead of offering the dashboard', () => {
    expect(renderBoard([entry({ kind: 'localPrompt', what: 'permission' })])).toEqual({
      title: 'proj · permission',
      body: 'Waiting at the terminal — answer it there.',
    });
    expect(renderBoard([entry({ kind: 'subagent', what: 'Read · sub-agent' })])).toEqual({
      title: 'proj · Read · sub-agent',
      body: 'Waiting at the terminal — answer it there.',
    });
  });

  it('a lone idle session says what it is waiting for', () => {
    expect(renderBoard([entry({ kind: 'idle', what: 'your input' })])).toEqual({
      title: 'proj · your input',
      body: 'Waiting for your input at the terminal.',
    });
  });

  it('several sessions aggregate into ONE toast, one bullet each', () => {
    const out = renderBoard([
      entry({ id: 'a', key: '/w/api', label: 'redreels-api', what: 'Bash' }),
      entry({ id: 'b', key: '/w/vf', label: 'vision-factory', kind: 'idle', what: 'your input' }),
      entry({ id: 'c', key: '/w/tl', label: 'tlive', kind: 'localPrompt', what: 'permission' }),
    ]);
    expect(out).toEqual({
      title: '3 sessions need you',
      body: '• redreels-api · Bash\n• vision-factory · your input\n• tlive · permission',
    });
  });

  it('counts SESSIONS, not entries — two dialogs in one session is not "2 sessions"', () => {
    const out = renderBoard([
      entry({ id: 'a', key: '/w/proj', label: 'proj', what: 'Bash' }),
      entry({ id: 'b', key: '/w/proj', label: 'proj', what: 'Edit' }),
    ]);
    expect(out!.title).toBe('proj · 2 waiting');
  });

  it('an unlabelled session (registry miss) still renders a usable line', () => {
    const out = renderBoard([entry({ label: '' }), entry({ id: 'b', key: '/w/x', label: 'x', what: 'Edit' })]);
    expect(out!.body).toBe('• Bash\n• x · Edit');
  });
});
