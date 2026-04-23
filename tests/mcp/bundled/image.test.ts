// tests/mcp/bundled/image.test.ts

import { describe, it, expect } from 'vitest';
import { makeImageOcrTool, makeImageDescribeTool, makeImageTools } from '../../../src/mcp/bundled/image/server.js';

describe('image bundled MCP (stub)', () => {
  it('ocr throws not-configured when env unset', async () => {
    delete process.env.TLIVE_IMAGE_PROVIDER;
    const r = await makeImageOcrTool().handler({ path: '/tmp/x.png' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/not configured/);
  });

  it('describe says not implemented when provider set but unimplemented', async () => {
    process.env.TLIVE_IMAGE_PROVIDER = 'anthropic';
    const r = await makeImageDescribeTool().handler({ path: '/tmp/x.png' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/anthropic/);
    delete process.env.TLIVE_IMAGE_PROVIDER;
  });

  it('makeImageTools returns 2 tools', () => {
    expect(makeImageTools()).toHaveLength(2);
  });
});
