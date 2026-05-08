// src/platform/feishu/emoji-map.ts
//
// Maps reaction-tracker phase emoji (unicode) to Feishu's emoji_type
// string identifier (used by POST /open-apis/im/v1/messages/{id}/reactions).
//
// The 4 phase emoji come from src/im/reaction-tracker.ts EMOJI_FOR:
//   received   → 👀  (EYES)
//   processing → 🤔  (THINKING_FACE)
//   done_ok    → 👌  (OK)
//   done_err   → 💔  (BROKEN_HEART)
//
// emoji_type values are inferred from Feishu's documented catalogue. If
// the live API rejects any of these on POST, the errResponse field in the
// adapter's warn log will identify which one — update the value here and
// restart the daemon.
//
// Returns null for any unmapped emoji — callers (FeishuAdapter.setReaction)
// log a warn and skip the API call. Reaction is nice-to-have; never blocks
// turn render.

const MAP: Record<string, string> = {
  '👀': 'EYES',
  '🤔': 'THINKING_FACE',
  '👌': 'OK',
  '💔': 'BROKEN_HEART',
};

export function feishuEmojiType(unicode: string): string | null {
  return MAP[unicode] ?? null;
}
