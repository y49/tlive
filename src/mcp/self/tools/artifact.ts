// src/mcp/self/tools/artifact.ts
//
// `tlive.artifact.{upload,list}` — outbound artifacts from the agent into
// AttachmentStore. IM platform renderers later pick up `attachment_produced`
// events (fired by RemoteSession.recordAttachment) and push the file to
// whatever chat the workspace is bound to.

import type { McpTool, McpToolDeps } from '../deps.js';
import { jsonResult, errorResult, requireString, optionalString } from './util.js';

export function makeArtifactUploadTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.artifact.upload',
      description: 'Upload a file from the agent as an outbound attachment.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          content_base64: { type: 'string' },
          mime: { type: 'string' },
        },
        required: ['name', 'content_base64'],
        additionalProperties: false,
      },
    },
    async handler(args, ctx) {
      const name = requireString(args, 'name');
      const b64 = requireString(args, 'content_base64');
      const mime = optionalString(args, 'mime') ?? 'application/octet-stream';
      let data: Buffer;
      try { data = Buffer.from(b64, 'base64'); }
      catch { return errorResult('content_base64 is not valid base64'); }
      const att = await deps.attachments.register(ctx.sessionId, name, mime, data, 'outbound');
      // Let RemoteSession emit the attachment_produced event so T6 renderers fire.
      const s = deps.sessions.get(ctx.sessionId);
      if (s && s.kind === 'remote') {
        s.recordAttachment({ attachmentId: att.id, name: att.name, mime: att.mime, sizeBytes: att.sizeBytes, path: att.path });
      }
      return jsonResult({ id: att.id, path: att.path, sizeBytes: att.sizeBytes });
    },
  };
}

export function makeArtifactListTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.artifact.list',
      description: 'List attachments (inbound + outbound) for the calling session.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async handler(_args, ctx) {
      const items = deps.attachments.listForSession(ctx.sessionId).map((a) => ({
        id: a.id,
        name: a.name,
        mime: a.mime,
        sizeBytes: a.sizeBytes,
        direction: a.direction,
        createdAt: a.createdAt,
      }));
      return jsonResult({ items });
    },
  };
}
