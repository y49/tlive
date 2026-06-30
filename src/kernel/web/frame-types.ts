// src/kernel/web/frame-types.ts
//
// Single source of truth for the per-session stream-protocol frame types.
// Wire format per frame: [1 byte type][4 byte uint32 BE length][payload].
// Imported by both the Node codec (stream-protocol.ts) and the browser codec (web/src/frame.ts).

export const FrameType = {
  Data: 0x01,
  Resize: 0x02,
  Attach: 0x03,
  Detach: 0x04,
  SnapshotRequest: 0x05,
  SnapshotReply: 0x06,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];
