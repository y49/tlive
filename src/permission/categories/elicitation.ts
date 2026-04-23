// src/permission/categories/elicitation.ts
//
// Render shape for `elicitation`-category requests. Note: the PermissionBroker
// itself doesn't carry ElicitationRequests — those live in ElicitationBroker
// — but the IM renderer uses the same categorized RenderData union to keep
// layout code uniform. This file's `render()` accepts an ElicitationRequest
// directly so the T6 renderer can switch on `data.kind`.

import type { ElicitationRequest } from '../../runtime/types.js';

export interface ElicitationRenderData {
  kind: 'elicitation';
  requestId: string;
  mode: 'form' | 'url-auth' | 'confirm';
  mcpServerName: string;
  description?: string;
  /** Only present in `form` mode. */
  fields?: ElicitationRequest['schema'];
  /** Only present in `url-auth` mode. */
  url?: string;
}

export function render(req: ElicitationRequest): ElicitationRenderData {
  return {
    kind: 'elicitation',
    requestId: req.id,
    mode: req.mode,
    mcpServerName: req.mcpServerName,
    description: req.description,
    fields: req.mode === 'form' ? req.schema : undefined,
    url: req.mode === 'url-auth' ? req.url : undefined,
  };
}
