import { describe, it, expect } from 'vitest';
import { WaitingBoard, renderBoard, canSkipProjection, type WaitingEntry } from '../waiting-board.js';

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

  describe('removeWhere', () => {
    it('retires every entry matching the predicate, and reports whether anything was removed', () => {
      const b = new WaitingBoard();
      b.add(entry({ id: 'a', key: '/w/s1', kind: 'subagent', what: 'Bash · sub-agent' }));
      b.add(entry({ id: 'b', key: '/w/s1', kind: 'subagent', what: 'Read · sub-agent' }));
      b.add(entry({ id: 'c', key: '/w/s2', kind: 'held', what: 'Bash' }));
      expect(b.removeWhere((e) => e.kind === 'subagent' && e.key === '/w/s1')).toBe(true);
      expect(b.entries().map((e) => e.id)).toEqual(['c']);
    });

    it('is a no-op, not a throw, when nothing matches — and reports false', () => {
      const b = new WaitingBoard();
      b.add(entry({ id: 'a' }));
      expect(b.removeWhere((e) => e.kind === 'idle')).toBe(false);
      expect(b.size()).toBe(1);
    });

    it('can narrow by a field beyond kind+key — e.g. the exact `what` a permission-denied event names', () => {
      const b = new WaitingBoard();
      b.add(entry({ id: 'a', key: '/w/s1', kind: 'subagent', what: 'Bash · sub-agent' }));
      b.add(entry({ id: 'b', key: '/w/s1', kind: 'subagent', what: 'Read · sub-agent' }));
      expect(b.removeWhere((e) => e.kind === 'subagent' && e.key === '/w/s1' && e.what === 'Bash · sub-agent')).toBe(true);
      expect(b.entries().map((e) => e.id)).toEqual(['b']);
    });

    it('emptying the board via removeWhere is indistinguishable from emptying it via remove — isEmpty() still flips', () => {
      const b = new WaitingBoard();
      b.add(entry({ id: 'a' }));
      expect(b.removeWhere(() => true)).toBe(true);
      expect(b.isEmpty()).toBe(true);
    });
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

describe('canSkipProjection', () => {
  const v1 = { title: 'proj · Bash', body: 'Approval needed — click to open and answer' };
  const v2 = { title: 'other · Bash', body: 'Approval needed — click to open and answer' };

  it('identical view, alert:false — skip: nothing changed and nothing new arrived', () => {
    expect(canSkipProjection(v1, { ...v1 }, false)).toBe(true);
  });

  it('identical view, alert:true — do NOT skip: a new arrival must re-alert even when the text is unchanged', () => {
    expect(canSkipProjection(v1, { ...v1 }, true)).toBe(false);
  });

  it('different title, alert:false — do NOT skip: the text on screen would be wrong', () => {
    expect(canSkipProjection(v1, v2, false)).toBe(false);
  });

  it('different body, alert:false — do NOT skip: the text on screen would be wrong', () => {
    expect(canSkipProjection(v1, { ...v1, body: 'Waiting at the terminal — answer it there.' }, false)).toBe(false);
  });

  it('lastView is null — do NOT skip: there is nothing on screen to compare against', () => {
    expect(canSkipProjection(null, v1, false)).toBe(false);
  });
});
