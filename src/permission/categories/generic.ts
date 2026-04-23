// src/permission/categories/generic.ts
//
// Fallback render shape for category=`generic` PermissionRequests (arbitrary
// MCP / plugin / custom tools that aren't exec or file-edit). The IM
// renderer draws the toolName as header and the serialized JSON input as a
// code block.

import type { PermissionRequest } from '../../runtime/types.js';

export interface GenericRenderData {
  kind: 'generic';
  toolName: string;
  /** Pretty-printed JSON of req.toolInput, safely stringified. */
  inputJson: string;
}

export function render(req: PermissionRequest): GenericRenderData {
  return {
    kind: 'generic',
    toolName: req.toolName,
    inputJson: safeStringify(req.toolInput),
  };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return '[unserializable]';
  }
}
