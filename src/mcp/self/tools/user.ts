// src/mcp/self/tools/user.ts
//
// `tlive.user.current()` — introspection of the calling operator. Useful for
// agents that want to tag memory / audit logs with the human driver.

import type { McpTool, McpToolDeps } from '../deps.js';
import { jsonResult } from './util.js';

export function makeUserCurrentTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.user.current',
      description: 'Return info about the current IM user driving this tlive daemon.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async handler() {
      return jsonResult(deps.user());
    },
  };
}
