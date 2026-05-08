// src/platform/feishu/emoji-map.ts
//
// Maps reaction-tracker phase emoji (unicode) to Feishu's emoji_type
// string identifier (used by POST /open-apis/im/v1/messages/{id}/reactions).
//
// The 5 phase emoji come from src/im/reaction-tracker.ts:
//   received → 👀, working → ⏳, done → ✅, error → ❌, revert → 🤔
//
// emoji_type values are inferred from Feishu's documented catalogue. If
// the live API rejects any of these on POST, update the value here and
// re-run the integration test (Task 4 will surface this).
//
// Returns null for any unmapped emoji — callers (FeishuAdapter.setReaction)
// log a warn and skip the API call. Reaction is nice-to-have; never blocks
// turn render.

const MAP: Record<string, string> = {
  '👀': 'EYES',
  '⏳': 'HOURGLASS_FLOWING_SAND',
  '✅': 'DONE',
  '❌': 'X',
  '🤔': 'THINKING',
};

export function feishuEmojiType(unicode: string): string | null {
  return MAP[unicode] ?? null;
}
