// src/kernel/contracts/mcp-tools.ts
//
// FROZEN SURFACE — DO NOT MODIFY without bumping major version.

export type FrozenMcpToolName =
  | 'mcp__tlive__approve'
  | 'mcp__tlive__ask'
  | 'mcp__tlive__notify';

export interface FrozenMcpTool {
  name: FrozenMcpToolName;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const FROZEN_MCP_TOOLS: readonly FrozenMcpTool[] = [
  {
    name: 'mcp__tlive__approve',
    description:
      'Request permission for a tool use. Pushes the request to the bound IM chat for the current workspace and waits for user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        toolName: { type: 'string' },
        input: { type: 'object' },
      },
      required: ['toolName', 'input'],
    },
  },
  {
    name: 'mcp__tlive__ask',
    description: 'Ask the user a question via IM and wait for a reply.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        timeoutSec: { type: 'number' },
      },
      required: ['question'],
    },
  },
  {
    name: 'mcp__tlive__notify',
    description: 'Push a non-blocking notification to IM (no user response required).',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        level: { type: 'string', enum: ['info', 'warn', 'error'] },
      },
      required: ['message'],
    },
  },
] as const;
