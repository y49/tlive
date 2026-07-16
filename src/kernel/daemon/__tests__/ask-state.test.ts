import { describe, it, expect } from 'vitest';
import { AskSelection } from '../ask-state.js';

describe('AskSelection', () => {
  it('toggles an index on and off', () => {
    const s = new AskSelection();
    s.toggle('r1', 0);
    expect(s.selected('r1')).toEqual([0]);
    s.toggle('r1', 0);
    expect(s.selected('r1')).toEqual([]);
  });

  it('keeps selections sorted and deduped', () => {
    const s = new AskSelection();
    s.toggle('r1', 2); s.toggle('r1', 0); s.toggle('r1', 2); s.toggle('r1', 2);
    expect(s.selected('r1')).toEqual([0, 2]);
  });

  it('isolates requests from each other', () => {
    const s = new AskSelection();
    s.toggle('r1', 0); s.toggle('r2', 1);
    expect(s.selected('r1')).toEqual([0]);
    expect(s.selected('r2')).toEqual([1]);
  });

  it('clear frees the request', () => {
    const s = new AskSelection();
    s.toggle('r1', 0);
    s.clear('r1');
    expect(s.selected('r1')).toEqual([]);
  });

  it('reports empty for unknown requests', () => {
    expect(new AskSelection().selected('nope')).toEqual([]);
  });
});
