// src/im/icons.ts
// Centralized notification labels.
// Single source of truth — change here to affect all IM notifications.

export const LABEL = {
  permission: '⚠ Permission',
  question:   '❓ Question',
  done:       '✓ Done',
  error:      '✗ Error',
  thinking:   '... Thinking',
  tasks:      '☰ Tasks',
  terminal:   'Terminal',
  tool:       '▸',           // prefix for tool call lines
  replyHint:  '↩ Reply to this message to interact',
} as const;
