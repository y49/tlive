// tests/runtime/codex/approval-split.test.ts
//
// Unit test for Codex approval handlers splitting the three server-request
// types (exec / file-edit / generic) into categorized PermissionRequests,
// with risk heuristics + diff line counts, and outcome translation.

import { describe, it, expect } from 'vitest';
import {
  makeExecApprovalHandler,
  makeFileChangeApprovalHandler,
} from '../../../src/runtime/codex/approval-handler.js';
import type { PermissionRequest } from '../../../src/runtime/types.js';

describe('codex approval split', () => {
  it('exec: categorizes rm -rf as high risk', async () => {
    const emitted: PermissionRequest[] = [];
    const handler = makeExecApprovalHandler({
      sdkSessionId: () => 'abc',
      emitRequest: (r) => emitted.push(r),
    });
    const p = handler({ command: 'rm -rf /tmp/foo' });
    const req = emitted[0];
    expect(req.category).toBe('exec');
    expect(req.risk).toBe('high');
    expect(req.id.startsWith('abc:')).toBe(true);
    req.resolve('allow');
    await expect(p).resolves.toEqual({ outcome: 'approved_for_request' });
  });

  it('file-edit: parses diff line counts', async () => {
    const emitted: PermissionRequest[] = [];
    const handler = makeFileChangeApprovalHandler({
      sdkSessionId: () => 'abc',
      emitRequest: (r) => emitted.push(r),
    });
    const p = handler({ path: 'src/a.ts', diff: '--- a\n+++ b\n-old\n+new1\n+new2\n' });
    const req = emitted[0];
    expect(req.category).toBe('file-edit');
    expect(req.diffPreview?.added).toBe(2);
    expect(req.diffPreview?.removed).toBe(1);
    req.resolve('deny');
    await expect(p).resolves.toEqual({ outcome: 'denied' });
  });

  it('file-edit: allow_always yields approved_for_session', async () => {
    const emitted: PermissionRequest[] = [];
    const handler = makeFileChangeApprovalHandler({
      sdkSessionId: () => 's2',
      emitRequest: (r) => emitted.push(r),
    });
    const p = handler({ path: 'src/b.ts', diff: '+one\n' });
    emitted[0].resolve('allow_always');
    await expect(p).resolves.toEqual({ outcome: 'approved_for_session' });
  });
});
