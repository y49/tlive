import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeSessionFailure, enrichStopFailure } from '../session-error.js';
import { parseHookInput } from '../normalizer.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function transcript(lines: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), 'tlive-failure-')); dirs.push(dir);
  const path = join(dir, 'transcript.jsonl');
  await writeFile(path, lines.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join('\n') + '\n');
  return path;
}
const user = { type: 'user', sessionId: 's', message: { role: 'user', content: 'Private prompt' } };
const api = (message: string) => ({ type: 'system', subtype: 'api_error', sessionId: 's', error: { message } });

describe('describeSessionFailure', () => {
  it.each([
    ['server_error', 'SSL certificate hostname mismatch', 'tls', false],
    ['overloaded', 'CERT_HAS_EXPIRED', 'tls', false],
    ['server_error', 'TLS handshake failed', 'tls', false],
    ['server_error', 'ERR_TLS_HANDSHAKE_TIMEOUT', 'tls', false],
    ['overloaded', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'tls', false],
    ['server_error', 'Invalid API key (401 Unauthorized)', 'authentication', false],
    ['oauth_org_not_allowed', '', 'authentication', false],
    ['server_error', 'Credit balance too low', 'quota', false],
    ['account_on_hold', '', 'quota', false],
    ['rate_limit', 'insufficient_quota', 'quota', false],
    ['billing_error', '', 'quota', false],
    ['rate_limit', 'Too many requests', 'transient', true],
    ['overloaded', '', 'transient', true],
    ['server_error', 'Connection lost mid-response', 'transient', true],
    ['unknown', 'ETIMEDOUT', 'transient', true],
    ['unknown', 'ECONNRESET', 'transient', true],
    ['unknown', 'ECONNREFUSED', 'transient', true],
    ['server_error', '', 'unknown', false],
    ['server_error', 'Internal failure', 'unknown', false],
    ['invalid_request', '', 'unknown', false],
  ] as const)('%s / %s classifies as %s', (kind, details, category, retryable) => {
    expect(describeSessionFailure(kind, details)).toMatchObject({ category, retryable, transient: retryable });
    expect(describeSessionFailure(kind, details).hint.length).toBeGreaterThan(0);
  });
  it('redacts complete URLs, credential assignments, bearer tokens and key literals before truncation', () => {
    const result = describeSessionFailure('server_error', 'TLS failed https://alice:password@example.test/path?token=querysecret Authorization: Bearer bearer-secret api_key=key-secret token: token-secret "access_token":"json-secret" sk-ant-secret-value Bearer token-prefixed-secret');
    expect(result.text).toContain('server_error');
    expect(result.text).toContain('TLS failed');
    for (const secret of ['alice', 'password', 'example.test', 'querysecret', 'bearer-secret', 'key-secret', 'token-secret', 'json-secret', 'sk-ant-secret-value', 'token-prefixed-secret']) expect(result.text).not.toContain(secret);
  });
  it.each([
    ['ANTHROPIC_AUTH_TOKEN=proxy-secret', 'proxy-secret'],
    ['ANTHROPIC_API_KEY=proxy-secret', 'proxy-secret'],
    ['CUSTOM_SERVICE_ACCESS_TOKEN=custom-secret', 'custom-secret'],
    ['Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['Authorization: Bearer bearer-secret', 'bearer-secret'],
    ['\"Authorization\":\"Basic dXNlcjpwYXNz\"', 'dXNlcjpwYXNz'],
  ])('redacts prefixed credentials and complete authorization values: %s', (details, secret) => {
    const failure = describeSessionFailure('server_error', details);
    expect(failure.text).not.toContain(secret);
  });
  it('redacts credential values even when the kind itself is malformed input', () => {
    expect(describeSessionFailure('https://secret.test/?token=secret', '').text).not.toContain('secret');
  });
});

describe('enrichStopFailure', () => {
  it('recovers only a terminal system API error after the current user prompt and sanitizes it', async () => {
    const path = await transcript([user, api('old failure'), user, { type: 'assistant', sessionId: 's', message: { content: 'Private answer' } }, api('TLS certificate mismatch https://name:password@secret.test/?key=private')]);
    const result = await enrichStopFailure({ error: 'server_error', session_id: 's', transcript_path: path }) as any;
    expect(result.error_details).toContain('TLS certificate mismatch');
    expect(result.error_details).not.toMatch(/password|private|secret\.test|Private answer|old failure/);
  });
  it('preserves hard-error prose following an authorization credential in recovered details', async () => {
    const path = await transcript([user, api('Authorization: Bearer proxy-secret; TLS certificate hostname mismatch')]);
    const raw = await enrichStopFailure({ error: 'overloaded', session_id: 's', transcript_path: path });
    const failure = parseHookInput('stop-failure', raw);
    expect(failure).toMatchObject({ sessionError: { category: 'tls', retryable: false, transient: false } });
    expect(JSON.stringify(failure)).not.toContain('proxy-secret');
    expect(JSON.stringify(failure)).toContain('TLS certificate hostname mismatch');
  });
  it('retains late hard-error evidence for classification while display remains bounded', async () => {
    const path = await transcript([user, api('Connection reset ' + 'x'.repeat(300) + ' TLS certificate hostname mismatch')]);
    const result = await enrichStopFailure({ session_id: 's', transcript_path: path }) as any;
    const failure = describeSessionFailure('overloaded', result.error_details);
    expect(failure).toMatchObject({ category: 'tls', retryable: false });
    expect(failure.text.length).toBeLessThan(300);
  });
  it('preserves explicit details and does not replace them with transcript contents', async () => {
    const raw = { error_details: 'explicit', transcript_path: await transcript([user, api('other')]) };
    expect(await enrichStopFailure(raw)).toBe(raw);
  });
  it.each([
    [api('earlier failure'), user],
    [user, api('earlier failure'), { type: 'assistant', message: { content: 'Done' } }],
    [user, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'secret tool error' }] } }],
    [user, { type: 'system', subtype: 'api_error', error: { body: 'secret raw body' } }],
    [api('no visible turn boundary')],
    [user, api('failure'), '{malformed'],
    [user, { ...api('another session'), sessionId: 'other' }],
    [user, { ...api('failure'), error: 'unknown error object shape' }],
  ])('refuses stale, unscoped, malformed or non-message transcript data', async (...lines: unknown[]) => {
    const raw = { session_id: 's', transcript_path: await transcript(lines) };
    expect(await enrichStopFailure(raw)).toBe(raw);
  });
  it('ignores missing files and invalid raw input safely', async () => {
    const raw = { transcript_path: '/nonexistent/tlive-transcript' };
    expect(await enrichStopFailure(raw)).toBe(raw);
    expect(await enrichStopFailure(null)).toBe(null);
  });
  it('does not reach past the 64KB tail to find a turn boundary', async () => {
    const raw = { transcript_path: await transcript([user, { type: 'assistant', message: { content: 'x'.repeat(70_000) } }, api('terminal failure')]) };
    expect(await enrichStopFailure(raw)).toBe(raw);
  });
});
