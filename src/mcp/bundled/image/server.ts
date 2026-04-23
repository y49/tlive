// src/mcp/bundled/image/server.ts
//
// `image` bundled MCP server — stub. Full OCR / vision tools ship in a
// later PR; this module exists so the structure is in place and the
// registry can declare an `image` entry. On tool invocation, we throw
// "not configured" unless `TLIVE_IMAGE_PROVIDER` is set — future work
// will plug in Anthropic vision API or a local provider.

export interface ImageToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function unconfigured(provider?: string): ImageToolResult {
  return {
    content: [{
      type: 'text',
      text: provider
        ? `image provider "${provider}" not yet implemented (stub)`
        : 'image provider not configured. Set TLIVE_IMAGE_PROVIDER to enable.',
    }],
    isError: true,
  };
}

export function makeImageOcrTool() {
  return {
    definition: {
      name: 'image.ocr',
      description: 'Run OCR on an image file. Requires TLIVE_IMAGE_PROVIDER.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string' },
          lang: { type: 'string' },
        },
        required: ['path'],
      },
    },
    async handler(_args: Record<string, unknown>): Promise<ImageToolResult> {
      return unconfigured(process.env.TLIVE_IMAGE_PROVIDER);
    },
  };
}

export function makeImageDescribeTool() {
  return {
    definition: {
      name: 'image.describe',
      description: 'Produce a description of an image. Requires TLIVE_IMAGE_PROVIDER.',
      inputSchema: {
        type: 'object' as const,
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    async handler(_args: Record<string, unknown>): Promise<ImageToolResult> {
      return unconfigured(process.env.TLIVE_IMAGE_PROVIDER);
    },
  };
}

export function makeImageTools() {
  return [makeImageOcrTool(), makeImageDescribeTool()];
}
