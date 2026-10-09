import { open, stat } from 'node:fs/promises';

export type SessionFailureCategory = 'tls' | 'authentication' | 'quota' | 'transient' | 'unknown';
export interface SessionFailureDescription {
  text: string;
  transient: boolean;
  retryable: boolean;
  category: SessionFailureCategory;
  hint: string;
}

/** Redact before truncating, so a secret spanning the output boundary cannot leak. */
function sanitize(value: string): string {
  return value
    .replace(/\b(?:https?|socks5?):\/\/[^\s<>"']+/gi, '[URL redacted]')
    .replace(/(["']?\b(?:[a-z0-9]+[_-])*authorization\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:[a-z][a-z0-9_-]*[ \t]+)?[^\s,;]+)/gi, '$1[redacted]')
    .replace(/\bBearer\s+(?!token(?:\s|$))[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/(["']?\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/\b(?:sk|pk)-(?:ant-)?[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim();
}

/** Generic server_error is insufficient evidence for a safe retry. Hard errors
 *  in either field take precedence, including when the outer kind is overloaded. */
export function describeSessionFailure(kind: string, details: string): SessionFailureDescription {
  const evidence = `${kind} ${details}`.toLowerCase();
  let category: SessionFailureCategory = 'unknown';
  let hint = 'Inspect the error and session configuration before resuming the turn.';
  if (/(?:^|[^a-z0-9])(?:tls|ssl)(?:$|[^a-z0-9])|certificate|cert_(?:has_expired|altname_invalid)|unable_to_verify_leaf_signature|unable_to_get_issuer_cert|self_signed_cert|hostname mismatch/.test(evidence)) {
    category = 'tls';
    hint = 'Check the server hostname, certificate trust and proxy configuration, then resume manually.';
  } else if (/authentication|unauthori[sz]ed|invalid.{0,20}(?:api.?key|token|credential)|oauth_org_not_allowed|forbidden|\b(?:401|403)\b/.test(evidence)) {
    category = 'authentication';
    hint = 'Check credentials, sign-in and organization access, then resume manually.';
  } else if (/billing|account_on_hold|insufficient[_ ]quota|credit balance|balance.{0,20}(?:low|exhaust)|payment|quota.{0,20}(?:exceed|exhaust)|usage limit/.test(evidence)) {
    category = 'quota';
    hint = 'Check billing, available credits and account limits, then resume manually.';
  } else if (/overloaded|rate[_ -]?limit|too many requests|\b429\b|timeout|timed out|etimedout|econnreset|econnrefused|connection.{0,30}(?:lost|reset|refused|closed)|network.{0,20}(?:error|failure)|socket hang up|temporarily unavailable/.test(evidence)) {
    category = 'transient';
    hint = 'Wait briefly, then retry the stopped turn.';
  }
  const transient = category === 'transient';
  const safeKind = sanitize(kind).slice(0, 80) || 'unknown';
  const safeDetails = sanitize(details).slice(0, 200);
  return { text: `${safeKind}${safeDetails ? ` — ${safeDetails}` : ''}`, transient, retryable: transient, category, hint };
}

const TAIL_BYTES = 64 * 1024;
const READ_BUDGET_MS = 150;

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

async function recoverDetails(raw: RecordValue): Promise<string | undefined> {
  if (typeof raw.transcript_path !== 'string' || !raw.transcript_path) return undefined;
  // Avoid opening directories or blocking device/FIFO inputs. Recheck after open.
  if (!(await stat(raw.transcript_path)).isFile()) return undefined;
  const file = await open(raw.transcript_path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) return undefined;
    const length = Math.min(info.size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, info.size - length);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const lines = text.split('\n');
    if (info.size > length) lines.shift(); // The first retained line can be partial.
    while (lines.length && !lines.at(-1)?.trim()) lines.pop();
    if (!lines.length) return undefined;
    const entries = lines.map(line => {
      try { return record(JSON.parse(line)); } catch { return undefined; }
    });
    const last = entries.at(-1);
    if (last?.type !== 'system' || last.subtype !== 'api_error') return undefined;
    const message = record(last.error)?.message;
    if (typeof message !== 'string' || !message.trim()) return undefined;
    // Restrict to the last visible human turn; a tool_result is never a prompt.
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (!entry) return undefined;
      if (typeof raw.session_id === 'string' && raw.session_id && entry.sessionId !== raw.session_id) return undefined;
      if (entry.type !== 'user') continue;
      const msg = record(entry.message);
      if (msg?.role !== 'user') return undefined;
      const content = msg.content;
      const isPrompt = typeof content === 'string' || (Array.isArray(content) && content.length > 0 && content.every(block => record(block)?.type === 'text'));
      if (isPrompt) return sanitize(message);
    }
    return undefined;
  } finally {
    await file.close();
  }
}

/** Opt-in by the caller for StopFailure only. Fail closed if the transcript
 *  tail cannot prove a terminal API error in the latest visible human turn.
 *  File work has a fixed byte limit and never delays the hook beyond its budget. */
export async function enrichStopFailure(raw: unknown): Promise<unknown> {
  const value = record(raw);
  if (!value || (typeof value.error_details === 'string' && value.error_details.trim())) return raw;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const details = await Promise.race([
      recoverDetails(value).catch(() => undefined),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), READ_BUDGET_MS); }),
    ]);
    return details ? { ...value, error_details: details } : raw;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
