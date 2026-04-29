import { describe, it, expect, vi } from 'vitest';
import { FeishuAdapter } from '../../../src/platform/feishu/adapter.js';
import { RateLimitError } from '../../../src/platform/types.js';

/**
 * Two rate-limit shapes Lark surfaces:
 *  1. HTTP 429 — axios throws an error whose `response.status === 429`.
 *  2. JSON body — call resolves with `{ code: 99991663, msg }` (open-platform
 *     frequency limit). Lark default interceptor returns `resp.data` directly,
 *     so a 200 OK with non-zero `code` looks like a normal resolve.
 */

describe('FeishuAdapter — 429 rate-limit', () => {
  it('HTTP 429 (axios-style throw) → RateLimitError', async () => {
    const httpErr = Object.assign(new Error('Request failed with status code 429'), {
      response: { status: 429, data: { code: 99991663, msg: 'too many requests' } },
    });
    const client = {
      im: {
        v1: {
          message: {
            create: vi.fn().mockRejectedValue(httpErr),
            patch: vi.fn().mockResolvedValue({}),
            delete: vi.fn().mockResolvedValue({}),
          },
          pin: { create: vi.fn().mockResolvedValue({}) },
        },
      },
    };
    const adapter = new FeishuAdapter({ appId: 'a', appSecret: 's', client });
    let thrown: unknown;
    try {
      await adapter.send({ chatId: 'c1', text: 'hi' });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(RateLimitError);
    const e = thrown as RateLimitError;
    expect(e.platform).toBe('feishu');
    expect(e.retryAfterMs).toBe(1000);
    expect(e.message).toContain('too many requests');
  });

  it('lark code 99991663 in body → RateLimitError', async () => {
    const client = {
      im: {
        v1: {
          message: {
            create: vi.fn().mockResolvedValue({ code: 99991663, msg: 'frequency limit hit', data: {} }),
            patch: vi.fn().mockResolvedValue({}),
            delete: vi.fn().mockResolvedValue({}),
          },
          pin: { create: vi.fn().mockResolvedValue({}) },
        },
      },
    };
    const adapter = new FeishuAdapter({ appId: 'a', appSecret: 's', client });
    let thrown: unknown;
    try {
      await adapter.send({ chatId: 'c1', text: 'hi' });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(RateLimitError);
    const e = thrown as RateLimitError;
    expect(e.platform).toBe('feishu');
    expect(e.retryAfterMs).toBe(1000);
    expect(e.message).toBe('frequency limit hit');
  });

  it('updateCard 429 in body → RateLimitError', async () => {
    const client = {
      im: {
        v1: {
          message: {
            create: vi.fn().mockResolvedValue({ data: { message_id: 'm1' } }),
            patch: vi.fn().mockResolvedValue({ code: 99991663, msg: 'edit too fast' }),
            delete: vi.fn().mockResolvedValue({}),
          },
          pin: { create: vi.fn().mockResolvedValue({}) },
        },
      },
    };
    const adapter = new FeishuAdapter({ appId: 'a', appSecret: 's', client });
    let thrown: unknown;
    try {
      await adapter.updateCard('m1', 'c1', { schema: '2.0' });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(RateLimitError);
    expect((thrown as RateLimitError).platform).toBe('feishu');
  });
});
