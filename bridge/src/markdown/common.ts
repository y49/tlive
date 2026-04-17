export function normalizeSpacingForIM(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/([^\n])\n(#{1,6}\s)/g, '$1\n\n$2')
    .replace(/(#{1,6}\s.+)\n([^\n#`\-*+]|\d+\.)/g, '$1\n\n$2')
    .replace(/([^\n])\n(```)/g, '$1\n\n$2')
    .replace(/(```)\n([^\n])/g, '$1\n\n$2')
    .replace(/([^\n])\n((?:[-*+] |\d+\. ))/g, '$1\n\n$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeHeadingsForIM(text: string): string {
  return text.replace(/^#{1,6}\s+(.+)$/gm, '**$1**');
}

export function normalizeForIM(text: string): string {
  return normalizeHeadingsForIM(normalizeSpacingForIM(text));
}
