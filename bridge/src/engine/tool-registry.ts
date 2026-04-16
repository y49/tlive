import { basename } from 'node:path';

const TOOL_ICONS: Record<string, string> = {
  Read: '📖', Edit: '✏️', Write: '📝',
  Bash: '🖥️', Grep: '🔍', Glob: '📂',
  Agent: '🤖', WebSearch: '🌐', WebFetch: '🌐',
};

/** Tools whose results are not shown in the terminal card */
const SILENT_RESULT_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Agent', 'WebSearch', 'WebFetch']);

/** Max lines of tool output to show in preview */
export const TOOL_RESULT_MAX_LINES = 3;

export function getToolIcon(name: string): string {
  return TOOL_ICONS[name] ?? '🔧';
}

export function getToolTitle(name: string, input: Record<string, unknown>): string {
  if (!input || Object.keys(input).length === 0) return name;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write': {
      const file = basename(str(input.file_path));
      return file ? `${name}(${file})` : name;
    }
    case 'Grep': {
      const pattern = str(input.pattern);
      const path = str(input.path) || '.';
      return pattern ? `${name}("${pattern}" in ${path})` : name;
    }
    case 'Glob': {
      const pattern = str(input.pattern);
      return pattern ? `${name}(${pattern})` : name;
    }
    case 'Bash': {
      const cmd = str(input.command);
      if (!cmd) return name;
      const truncated = cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
      return `${name}(${truncated})`;
    }
    case 'Agent': {
      const desc = str(input.description) || str(input.prompt)?.slice(0, 60);
      return desc ? `${name}(${desc})` : name;
    }
    default:
      return name;
  }
}

export function getToolCommand(name: string, input: Record<string, unknown>): string {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const truncate = (s: string, n: number): string => s.length > n ? s.slice(0, n - 1) + '…' : s;
  const MAX = 150;

  switch (name) {
    case 'Read':
      return str(input.file_path);
    case 'Edit': {
      const file = str(input.file_path);
      const oldStr = truncate(str(input.old_string), 50);
      const newStr = truncate(str(input.new_string), 50);
      const parts = [file];
      if (oldStr) parts.push(`−${oldStr}`);
      if (newStr) parts.push(`+${newStr}`);
      return parts.join('\n');
    }
    case 'Write': {
      const file = str(input.file_path);
      const content = str(input.content);
      return content ? `${file} (${content.length} chars)` : file;
    }
    case 'Grep':
      return `"${str(input.pattern)}" in ${str(input.path) || '.'}`;
    case 'Glob':
      return str(input.pattern);
    case 'Bash':
      return truncate(str(input.command), MAX);
    case 'Agent':
    case 'Task':
      return str(input.description) || truncate(str(input.prompt), MAX) || '';
    case 'WebFetch':
      return str(input.url);
    case 'WebSearch':
      return str(input.query);
    case 'TodoWrite': {
      const todos = input.todos;
      const count = Array.isArray(todos) ? todos.length : 0;
      return `${count} todo items`;
    }
    default: {
      // Generic fallback — small JSON dump, truncated
      try {
        const json = JSON.stringify(input);
        return truncate(json, MAX);
      } catch {
        return '';
      }
    }
  }
}

export function getToolResultPreview(name: string, result: string, isError = false): string {
  if (isError) {
    const preview = result.length > 200 ? result.slice(0, 197) + '...' : result;
    return `❌ Error: ${preview}`;
  }
  if (!result || SILENT_RESULT_TOOLS.has(name)) return '';

  const lines = result.split('\n');
  if (lines.length <= TOOL_RESULT_MAX_LINES) return result;

  const shown = lines.slice(0, TOOL_RESULT_MAX_LINES).join('\n');
  return `${shown}\n… +${lines.length - TOOL_RESULT_MAX_LINES} lines`;
}
