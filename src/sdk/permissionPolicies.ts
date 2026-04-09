// src/sdk/permissionPolicies.ts
export type PermissionMode = 'default' | 'accept-edits' | 'auto-approve' | 'yolo';

const SAFE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'TodoRead', 'WebSearch']);
const EDIT_TOOLS = new Set([...SAFE_TOOLS, 'Edit', 'Write', 'NotebookEdit']);
const DANGEROUS_PATTERNS = [/rm\s+-rf/, /git\s+push.*--force/, /DROP\s+TABLE/i];

export function isAllowed(mode: PermissionMode, toolName: string, input: unknown): boolean {
  switch (mode) {
    case 'yolo':
      return true;
    case 'auto-approve': {
      if (toolName === 'Bash') {
        const cmd = (input as any)?.command ?? '';
        return !DANGEROUS_PATTERNS.some(p => p.test(cmd));
      }
      return true;
    }
    case 'accept-edits':
      return EDIT_TOOLS.has(toolName);
    case 'default':
      return SAFE_TOOLS.has(toolName);
  }
}
