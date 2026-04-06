import { z } from 'zod';

const baseSchema = z.object({ parentToolUseId: z.string().optional() });

const textDeltaSchema = z.object({
  kind: z.literal('text_delta'),
  text: z.string(),
}).merge(baseSchema).passthrough();

const thinkingDeltaSchema = z.object({
  kind: z.literal('thinking_delta'),
  text: z.string(),
}).merge(baseSchema).passthrough();

const toolStartSchema = z.object({
  kind: z.literal('tool_start'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
}).merge(baseSchema).passthrough();

const toolResultSchema = z.object({
  kind: z.literal('tool_result'),
  toolUseId: z.string(),
  content: z.string(),
  isError: z.boolean(),
}).merge(baseSchema).passthrough();

const toolProgressSchema = z.object({
  kind: z.literal('tool_progress'),
  toolName: z.string(),
  elapsed: z.number(),
}).merge(baseSchema).passthrough();

const agentUsageSchema = z.object({
  toolUses: z.number(),
  durationMs: z.number(),
}).passthrough();

const agentStartSchema = z.object({
  kind: z.literal('agent_start'),
  description: z.string(),
  taskId: z.string().optional(),
}).merge(baseSchema).passthrough();

const agentProgressSchema = z.object({
  kind: z.literal('agent_progress'),
  description: z.string(),
  lastTool: z.string().optional(),
  usage: agentUsageSchema.optional(),
}).merge(baseSchema).passthrough();

const agentCompleteSchema = z.object({
  kind: z.literal('agent_complete'),
  summary: z.string(),
  status: z.enum(['completed', 'failed', 'stopped']),
}).merge(baseSchema).passthrough();

const modelUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number().optional(),
  cacheCreationInputTokens: z.number().optional(),
  costUSD: z.number().optional(),
}).passthrough();

const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().optional(),
  modelUsage: z.record(z.string(), modelUsageSchema).optional(),
}).passthrough();

const permissionDenialSchema = z.object({
  toolName: z.string(),
  toolUseId: z.string(),
}).passthrough();

const queryResultSchema = z.object({
  kind: z.literal('query_result'),
  sessionId: z.string(),
  isError: z.boolean(),
  usage: usageSchema,
  permissionDenials: z.array(permissionDenialSchema).optional(),
}).passthrough();

const errorSchema = z.object({
  kind: z.literal('error'),
  message: z.string(),
}).passthrough();

const statusSchema = z.object({
  kind: z.literal('status'),
  sessionId: z.string(),
  model: z.string(),
}).passthrough();

const promptSuggestionSchema = z.object({
  kind: z.literal('prompt_suggestion'),
  suggestion: z.string(),
}).passthrough();

const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
}).passthrough();

const todoUpdateSchema = z.object({
  kind: z.literal('todo_update'),
  todos: z.array(todoItemSchema),
}).merge(baseSchema).passthrough();

const rateLimitSchema = z.object({
  kind: z.literal('rate_limit'),
  status: z.string(),
  utilization: z.number().optional(),
  resetsAt: z.number().optional(),
}).passthrough();

export const canonicalEventSchema = z.discriminatedUnion('kind', [
  textDeltaSchema,
  thinkingDeltaSchema,
  toolStartSchema,
  toolResultSchema,
  toolProgressSchema,
  agentStartSchema,
  agentProgressSchema,
  agentCompleteSchema,
  todoUpdateSchema,
  queryResultSchema,
  errorSchema,
  statusSchema,
  promptSuggestionSchema,
  rateLimitSchema,
]);

export type CanonicalEvent = z.infer<typeof canonicalEventSchema>;
