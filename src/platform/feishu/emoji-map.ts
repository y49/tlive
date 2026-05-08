// src/platform/feishu/emoji-map.ts
//
// Maps reaction-tracker phase emoji (unicode) to Feishu's emoji_type
// string identifier (used by POST /open-apis/im/v1/messages/{id}/reactions).
//
// The 4 phase emoji come from src/im/reaction-tracker.ts EMOJI_FOR:
//   received   → 👀  (GLANCE)
//   processing → 🤔  (THINKING)
//   done_ok    → 👌  (OK)
//   done_err   → 💔  (HEARTBROKEN)
//
// emoji_type values verified against Feishu's documented catalogue at
// https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
// (smoke-confirmed 2026-05-08; daemon.log errResponse code 231001 surfaces
// any future rejection if Feishu changes the catalogue).
//
// Returns null for any unmapped emoji — callers (FeishuAdapter.setReaction)
// log a warn and skip the API call. Reaction is nice-to-have; never blocks
// turn render.

const MAP: Record<string, string> = {
  '👀': 'GLANCE',
  '🤔': 'THINKING',
  '👌': 'OK',
  '💔': 'HEARTBROKEN',
};

export function feishuEmojiType(unicode: string): string | null {
  return MAP[unicode] ?? null;
}
