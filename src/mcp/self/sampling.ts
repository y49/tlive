// src/mcp/self/sampling.ts
//
// Wrap MCP `sampling/createMessage` into a friendlier `sample()` helper. Falls
// back to `null` when the client didn't declare sampling capability.

export interface SamplingMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string } | Array<{ type: 'text'; text: string }>;
}

export interface SamplingOpts {
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  systemPrompt?: string;
}

export interface SamplingResult {
  text: string;
  stopReason: string;
}

/** Contract the server plugs into: a thin wrapper around Server.createMessage. */
export interface SamplingClient {
  supported: () => boolean;
  createMessage: (params: {
    messages: SamplingMessage[];
    maxTokens: number;
    temperature?: number;
    stopSequences?: string[];
    systemPrompt?: string;
  }) => Promise<{ content: { type: string; text?: string }; stopReason?: string }>;
}

export async function sample(
  client: SamplingClient,
  messages: SamplingMessage[],
  opts: SamplingOpts = {},
): Promise<SamplingResult | null> {
  if (!client.supported()) return null;
  try {
    const out = await client.createMessage({
      messages,
      maxTokens: opts.maxTokens ?? 512,
      temperature: opts.temperature,
      stopSequences: opts.stopSequences,
      systemPrompt: opts.systemPrompt,
    });
    const text = out.content && out.content.type === 'text' ? (out.content.text ?? '') : '';
    return { text, stopReason: out.stopReason ?? 'end_turn' };
  } catch (err) {
    // Sampling failed client-side — log + return null. Callers treat null as
    // "no summary available" and render a graceful fallback.
    console.error('[sampling] createMessage failed:', err);
    return null;
  }
}

/** Generate a ≤1-line session title from the first user message. */
export async function generateSessionTitle(client: SamplingClient, firstUserMessage: string): Promise<string | null> {
  const res = await sample(client, [
    { role: 'user', content: { type: 'text', text: `Produce a 3-6 word title for this session's goal. Do not include quotes or punctuation.\n\nFirst user message:\n${firstUserMessage}` } },
  ], { maxTokens: 32 });
  return res ? res.text.trim() : null;
}

/** Rerank search hits — caller supplies them as text; we return an ordered index list. */
export async function rerankSearchHits(
  client: SamplingClient,
  query: string,
  candidates: string[],
): Promise<number[] | null> {
  if (candidates.length === 0) return [];
  const listed = candidates.map((c, i) => `[${i}] ${c}`).join('\n');
  const res = await sample(client, [
    { role: 'user', content: { type: 'text', text: `Given query: "${query}"\n\nRank these candidates most-to-least relevant. Return comma-separated index list, most relevant first.\n\n${listed}` } },
  ], { maxTokens: 64 });
  if (!res) return null;
  const nums = res.text.split(/[,\s]+/).map((t) => Number(t)).filter((n) => Number.isInteger(n) && n >= 0 && n < candidates.length);
  if (nums.length === 0) return null;
  return nums;
}

/** Produce a short leave-notification summary. */
export async function summarizeForLeaveNotification(client: SamplingClient, events: string[]): Promise<string | null> {
  const res = await sample(client, [
    { role: 'user', content: { type: 'text', text: `Summarize this session's progress in one sentence (≤40 words). Be plain; no bullet lists.\n\n${events.join('\n')}` } },
  ], { maxTokens: 80 });
  return res ? res.text.trim() : null;
}

/** Generate a daily digest from a list of summaries. */
export async function generateDailyDigest(client: SamplingClient, summaries: string[]): Promise<string | null> {
  const joined = summaries.map((s, i) => `- ${s}`).join('\n');
  const res = await sample(client, [
    { role: 'user', content: { type: 'text', text: `Produce a 3-bullet digest for today based on these sessions:\n\n${joined}` } },
  ], { maxTokens: 200 });
  return res ? res.text.trim() : null;
}

/** Explain a runtime error + context in natural language. */
export async function explainError(client: SamplingClient, error: { code: string; message: string; context?: string }): Promise<string | null> {
  const res = await sample(client, [
    { role: 'user', content: { type: 'text', text: `Explain this error to a developer in plain English, plus one suggested next step.\n\nCode: ${error.code}\nMessage: ${error.message}\nContext: ${error.context ?? '(none)'}` } },
  ], { maxTokens: 200 });
  return res ? res.text.trim() : null;
}
