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

/**
 * Split a Telegram-HTML string into chunks of <= maxLen characters where
 * possible, never breaking inside an atomic HTML tag block.
 *
 * Atomic tags: <pre>, <code>, <a>, <b>, <i>, <u>, <s>, <blockquote>.
 * If an atomic block exceeds maxLen on its own, it gets its own chunk
 * that exceeds maxLen — Telegram will render it; the alternative (torn
 * tags) is worse.
 *
 * Splitting strategy (greedy, in priority order):
 *   1. Paragraph boundary (\n\n) — preferred
 *   2. Line boundary (\n)
 *   3. Hard cut at maxLen (only when outside any open tag)
 */
export function chunkHtmlForTelegram(html: string, maxLen: number): string[] {
  if (html.length <= maxLen) return [html];

  const ATOMIC_TAGS = ['pre', 'code', 'a', 'b', 'i', 'u', 's', 'blockquote'];
  type Atom = { text: string; atomic: boolean };
  const atoms: Atom[] = [];

  let i = 0;
  while (i < html.length) {
    if (html[i] === '<') {
      const tagMatch = html.slice(i).match(/^<(\w+)(\s[^>]*)?>/);
      if (tagMatch) {
        const tagName = tagMatch[1].toLowerCase();
        if (ATOMIC_TAGS.includes(tagName)) {
          const closeRe = new RegExp(`</${tagName}>`, 'i');
          const rest = html.slice(i + tagMatch[0].length);
          const closeMatch = rest.match(closeRe);
          if (closeMatch) {
            const endIdx = i + tagMatch[0].length + closeMatch.index! + closeMatch[0].length;
            atoms.push({ text: html.slice(i, endIdx), atomic: true });
            i = endIdx;
            continue;
          }
        }
      }
    }
    atoms.push({ text: html[i], atomic: false });
    i++;
  }

  const chunks: string[] = [];
  let cur = '';

  function flushCurrent(): void {
    if (cur.length > 0) {
      chunks.push(cur);
      cur = '';
    }
  }

  for (const atom of atoms) {
    if (cur.length + atom.text.length <= maxLen) {
      cur += atom.text;
      continue;
    }
    if (atom.atomic) {
      flushCurrent();
      chunks.push(atom.text);
      continue;
    }
    const paraIdx = cur.lastIndexOf('\n\n');
    const lineIdx = cur.lastIndexOf('\n');
    if (paraIdx >= 0) {
      chunks.push(cur.slice(0, paraIdx));
      cur = cur.slice(paraIdx + 2);
    } else if (lineIdx >= 0) {
      chunks.push(cur.slice(0, lineIdx));
      cur = cur.slice(lineIdx + 1);
    } else {
      flushCurrent();
    }
    cur += atom.text;
  }
  flushCurrent();

  if (chunks.length === 0) chunks.push('');
  return chunks;
}
