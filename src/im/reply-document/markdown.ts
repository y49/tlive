// src/im/reply-document/markdown.ts
//
// markdown → Telegram HTML. Order matters:
//   1. fence code → sentinel (so inline rules don't touch fenced content)
//   2. global escapeHtml
//   3. inline code / bold / italic / heading
//   4. blockquote / hr / link / autolink
//   5. restore fences (autolink runs BEFORE restore, so fence content is safe)

import { escapeHtml } from '../util/html.js';

const SENTINEL_OPEN = ' \x00F\x00 ';
const SENTINEL_CLOSE = ' \x00E\x00 ';
const HR_BAR = '▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰';

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function markdownToTelegramHtml(md: string): string {
  const fences: string[] = [];
  let out = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang: string, body: string) => {
    const idx = fences.length;
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    fences.push(`<pre><code${langAttr}>${escapeHtml(body)}</code></pre>`);
    return `${SENTINEL_OPEN}${idx}${SENTINEL_CLOSE}`;
  });
  out = escapeHtml(out);

  out = out.replace(/`([^`\n]+)`/g, (_, x) => `<code>${x}</code>`);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_, x) => `<b>${x}</b>`);
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, (_, p, x) => `${p}<i>${x}</i>`);
  out = out.replace(/^(#{1,6})\s+(.+?)$/gm, (_, _h: string, body: string) => `<b>${body}</b>`);

  // blockquote(单行)— 行首 > (note: > was already escaped to &gt;)
  out = out.replace(/^&gt;\s?(.+?)$/gm, (_, body: string) => `<blockquote>${body}</blockquote>`);
  // hr — 单行 ---
  out = out.replace(/^---$/gm, HR_BAR);

  // 显式 link [text](url) — 仅 https? scheme,其他 scheme 退化为纯文本
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, text: string, url: string) => {
    return `<a href="${escapeAttr(url)}">${text}</a>`;
  });
  out = out.replace(/\[([^\]]+)\]\((?!https?:\/\/)[^)]+\)/g, '$1');

  // 自动链接 — must run BEFORE fence restore so sentinel-wrapped fence
  // content is invisible to this regex (sentinel chars contain \x00 which
  // \S matches, but the fence body lives entirely inside the sentinel pair).
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+?)([.,!?;:)]?)(?=\s|$)/g, (_m, pre: string, url: string, punct: string) => {
    return `${pre}<a href="${escapeAttr(url)}">${url}</a>${punct}`;
  });

  const restoreRe = new RegExp(` \x00F\x00 (\\d+) \x00E\x00 `, 'g');
  out = out.replace(restoreRe, (_, i) => fences[Number(i)] ?? '');
  return out;
}
