import { describe, it, expect } from 'vitest';
import { getToolIcon, getToolTitle, getToolCommand, getToolResultPreview, TOOL_RESULT_MAX_LINES } from '../engine/tool-registry.js';

describe('tool-registry', () => {
  describe('getToolIcon', () => {
    it('returns known icons for standard tools', () => {
      expect(getToolIcon('Read')).toBe('📖');
      expect(getToolIcon('Edit')).toBe('✏️');
      expect(getToolIcon('Write')).toBe('📝');
      expect(getToolIcon('Bash')).toBe('🖥️');
      expect(getToolIcon('Grep')).toBe('🔍');
      expect(getToolIcon('Glob')).toBe('📂');
      expect(getToolIcon('Agent')).toBe('🤖');
      expect(getToolIcon('WebSearch')).toBe('🌐');
      expect(getToolIcon('WebFetch')).toBe('🌐');
    });

    it('returns fallback for unknown tools', () => {
      expect(getToolIcon('CustomTool')).toBe('🔧');
    });
  });

  describe('getToolTitle', () => {
    it('extracts file name for Read/Edit/Write', () => {
      expect(getToolTitle('Read', { file_path: '/home/user/project/src/main.ts' })).toBe('Read(main.ts)');
      expect(getToolTitle('Edit', { file_path: '/tmp/bar.ts' })).toBe('Edit(bar.ts)');
      expect(getToolTitle('Write', { file_path: '/a/b/c.json' })).toBe('Write(c.json)');
    });

    it('extracts pattern for Grep/Glob', () => {
      expect(getToolTitle('Grep', { pattern: 'TODO', path: 'src/' })).toBe('Grep("TODO" in src/)');
      expect(getToolTitle('Glob', { pattern: '**/*.ts' })).toBe('Glob(**/*.ts)');
    });

    it('extracts command for Bash (truncated)', () => {
      expect(getToolTitle('Bash', { command: 'npm test' })).toBe('Bash(npm test)');
      const longCmd = 'find . -name "*.ts" -type f -exec grep -l "pattern" {} \\; | sort | head -20 | while read f; do echo "$f"; done';
      const title = getToolTitle('Bash', { command: longCmd });
      expect(title.length).toBeLessThanOrEqual(90);
    });

    it('shows agent description', () => {
      expect(getToolTitle('Agent', { description: 'Explore codebase' })).toBe('Agent(Explore codebase)');
    });

    it('returns just tool name for unknown or empty input', () => {
      expect(getToolTitle('CustomTool', {})).toBe('CustomTool');
      expect(getToolTitle('Read', {})).toBe('Read');
    });
  });

  describe('getToolCommand', () => {
    it('returns full file path for Read/Edit/Write', () => {
      expect(getToolCommand('Read', { file_path: '/home/user/src/main.ts' })).toBe('/home/user/src/main.ts');
      expect(getToolCommand('Edit', { file_path: '/tmp/bar.ts' })).toBe('/tmp/bar.ts');
      expect(getToolCommand('Write', { file_path: '/a/b/c.json' })).toBe('/a/b/c.json');
    });

    it('returns pattern with path for Grep', () => {
      expect(getToolCommand('Grep', { pattern: 'TODO', path: 'src/' })).toBe('"TODO" in src/');
      expect(getToolCommand('Grep', { pattern: 'foo' })).toBe('"foo" in .');
    });

    it('returns pattern for Glob', () => {
      expect(getToolCommand('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
    });

    it('returns full command for Bash (no truncation)', () => {
      expect(getToolCommand('Bash', { command: 'npm test' })).toBe('npm test');
      const longCmd = 'a'.repeat(100);
      const result = getToolCommand('Bash', { command: longCmd });
      expect(result).toBe(longCmd);
    });

    it('returns description for Agent', () => {
      expect(getToolCommand('Agent', { description: 'Explore codebase' })).toBe('Explore codebase');
    });

    it('returns empty braces for unknown tools with no input', () => {
      expect(getToolCommand('CustomTool', {})).toBe('{}');
    });

    it('returns truncated JSON for unknown tools', () => {
      expect(getToolCommand('CustomTool', { foo: 'bar' })).toBe('{"foo":"bar"}');
    });
  });

  describe('getToolResultPreview', () => {
    it('returns empty for no-result tools (Read, Glob)', () => {
      expect(getToolResultPreview('Read', 'file content here')).toBe('');
      expect(getToolResultPreview('Glob', 'file1.ts\nfile2.ts')).toBe('');
    });

    it('truncates long Bash output with line count', () => {
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
      const result = getToolResultPreview('Bash', lines.join('\n'));
      expect(result).toContain('line 1');
      expect(result).toContain(`+${30 - TOOL_RESULT_MAX_LINES} lines`);
    });

    it('TOOL_RESULT_MAX_LINES is 3', () => {
      expect(TOOL_RESULT_MAX_LINES).toBe(3);
    });

    it('shows short Bash output in full', () => {
      expect(getToolResultPreview('Bash', 'OK')).toBe('OK');
    });

    it('shows error results for any tool', () => {
      const result = getToolResultPreview('Read', 'File not found', true);
      expect(result).toContain('❌');
      expect(result).toContain('File not found');
    });
  });
});
