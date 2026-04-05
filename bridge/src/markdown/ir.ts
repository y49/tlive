import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true });

/**
 * Convert HTML table to monospace <pre> block with padded columns.
 */
function tableToMonospace(tableHtml: string): string {
  // Extract rows: split by <tr> tags, parse <td>/<th> cells
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;

  const rows: string[][] = [];
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
    }
    if (cells.length > 0) rows.push(cells);
  }

  if (rows.length === 0) return '';

  // Calculate column widths
  const colCount = Math.max(...rows.map(r => r.length));
  const widths: number[] = Array(colCount).fill(0);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      widths[i] = Math.max(widths[i], row[i].length);
    }
  }

  // Format rows with padding
  const lines = rows.map(row =>
    row.map((cell, i) => cell.padEnd(widths[i])).join('  ')
  );

  return '<pre>' + lines.join('\n') + '</pre>';
}

/**
 * Process HTML lists (ul/ol, nested) into indented text with bullets/numbers.
 */
function processLists(html: string): string {
  // Process nested lists by walking the HTML token by token
  // We need to handle <ul>, </ul>, <ol>, </ol>, <li>, </li>
  const result: string[] = [];
  let pos = 0;
  const stack: Array<{ type: 'ul' | 'ol'; counter: number }> = [];

  // Tokenize list-related tags
  const tagRegex = /<(\/?)(?:ul|ol|li)(?:\s[^>]*)?>/gi;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    // Add text before this tag
    const textBefore = html.slice(pos, match.index);
    if (textBefore.trim()) {
      result.push(textBefore);
    }
    pos = match.index + match[0].length;

    const isClosing = match[1] === '/';
    const tag = match[0].toLowerCase();

    if (!isClosing && (tag.startsWith('<ul') || tag.startsWith('<ol'))) {
      const type = tag.startsWith('<ul') ? 'ul' : 'ol';
      stack.push({ type, counter: 0 });
    } else if (isClosing && (tag === '</ul>' || tag === '</ol>')) {
      stack.pop();
    } else if (!isClosing && tag.startsWith('<li')) {
      const depth = stack.length - 1;
      const indent = '  '.repeat(Math.max(0, depth));
      const current = stack[stack.length - 1];
      if (current) {
        current.counter++;
        if (current.type === 'ul') {
          result.push(indent + '• ');
        } else {
          result.push(indent + current.counter + '. ');
        }
      }
    } else if (isClosing && tag === '</li>') {
      result.push('\n');
    }
  }

  // Add remaining text after last tag
  if (pos < html.length) {
    result.push(html.slice(pos));
  }

  return result.join('');
}

/**
 * Truncate code blocks exceeding maxLines.
 * Head: 60% of max, Tail: 20% of max, middle omitted with marker.
 */
export function truncateLongCodeBlocks(text: string, maxLines?: number): string {
  const limit = maxLines ?? (process.env.TL_CODE_BLOCK_MAX_LINES ? parseInt(process.env.TL_CODE_BLOCK_MAX_LINES, 10) : 50);
  const headCount = Math.floor(limit * 0.6);
  const tailCount = Math.floor(limit * 0.2);

  return text.replace(/(```[^\n]*\n)([\s\S]*?)(\n```)/g, (_match, open: string, body: string, close: string) => {
    const lines = body.split('\n');
    if (lines.length <= limit) return open + body + close;

    const head = lines.slice(0, headCount);
    const tail = lines.slice(lines.length - tailCount);
    const omitted = lines.length - headCount - tailCount;

    return open + head.join('\n') + '\n... (' + omitted + ' lines omitted)\n' + tail.join('\n') + close;
  });
}

/**
 * Convert markdown to Telegram-compatible HTML.
 */
export function markdownToHtml(text: string): string {
  // Pre-process: truncate long code blocks
  text = truncateLongCodeBlocks(text);

  let html = md.render(text);

  // Tables: replace <table>...</table> with monospace <pre>
  html = html.replace(/<table[\s\S]*?<\/table>/gi, (tableHtml) => tableToMonospace(tableHtml));

  // Strip <p> tags but preserve paragraph spacing
  html = html.replace(/<p>/g, '');
  html = html.replace(/<\/p>/g, '\n\n');

  // Headings -> bold
  html = html.replace(/<h[1-6][^>]*>/g, '<b>');
  html = html.replace(/<\/h[1-6]>/g, '</b>\n');

  // Process lists (ul/ol with nesting support)
  html = processLists(html);

  // Emphasis
  html = html.replace(/<em>/g, '<i>');
  html = html.replace(/<\/em>/g, '</i>');
  html = html.replace(/<strong>/g, '<b>');
  html = html.replace(/<\/strong>/g, '</b>');

  // Code blocks: strip language class from <code> inside <pre>
  html = html.replace(/<pre><code(?:\s+class="[^"]*")?>/g, '<pre>');
  html = html.replace(/<\/code><\/pre>/g, '</pre>');

  // Blockquotes
  html = html.replace(/<blockquote>\s*/g, '❝ ');
  html = html.replace(/<\/blockquote>\s*/g, '\n');

  // Strip <hr> tags
  html = html.replace(/<hr\s*\/?>/g, '---\n');

  // <br> is NOT supported by Telegram HTML parse mode — convert to newline
  // (Telegram API rejects <br> with 400: Unsupported start tag "br")
  html = html.replace(/<br\s*\/?>/gi, '\n');

  // Strip any remaining unsupported HTML tags (keep: b, i, s, u, code, pre, a)
  html = html.replace(/<\/?(?!b>|\/b>|i>|\/i>|s>|\/s>|u>|\/u>|code>|\/code>|pre>|\/pre>|a[\s>]|\/a>)[a-z][a-z0-9]*[^>]*>/gi, '');

  return html.trim();
}
