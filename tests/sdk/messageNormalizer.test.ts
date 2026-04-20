import { describe, it, expect } from 'vitest';
import { formatToolArgsBrief, extractTodos } from '../../src/sdk/messageNormalizer.js';

describe('formatToolArgsBrief', () => {
  it('Bash returns command', () => expect(formatToolArgsBrief('Bash', { command: 'ls' })).toBe('ls'));
  it('Read returns file_path', () => expect(formatToolArgsBrief('Read', { file_path: '/x' })).toBe('/x'));
  it('Edit returns file_path', () => expect(formatToolArgsBrief('Edit', { file_path: '/y' })).toBe('/y'));
  it('Grep returns pattern', () => expect(formatToolArgsBrief('Grep', { pattern: 'foo' })).toBe('foo'));
  it('Unknown tool returns first non-empty string value', () =>
    expect(formatToolArgsBrief('Mystery', { a: '', b: 'hello' })).toBe('hello'));
  it('Returns empty for no matching args', () => expect(formatToolArgsBrief('Xyz', {})).toBe(''));
  it('Returns empty for undefined tool', () => expect(formatToolArgsBrief(undefined, { a: 'x' })).toBe(''));
});

describe('extractTodos', () => {
  it('maps todos array', () => {
    const out = extractTodos({ todos: [{ content: 'a', status: 'completed' }] });
    expect(out).toEqual([{ content: 'a', status: 'completed' }]);
  });
  it('accepts `subject` alias for content', () => {
    const out = extractTodos({ todos: [{ subject: 'b', status: 'pending' }] });
    expect(out?.[0].content).toBe('b');
  });
  it('defaults status to pending when missing', () => {
    const out = extractTodos({ todos: [{ content: 'c' }] });
    expect(out?.[0].status).toBe('pending');
  });
  it('returns null when input is not an object', () => expect(extractTodos('x')).toBeNull());
  it('returns null when todos is not an array', () => expect(extractTodos({ todos: 'x' })).toBeNull());
});
