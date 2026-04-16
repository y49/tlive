export function splitContent(
  content: string,
  maxLen: number,
  webTerminalUrl: string | undefined,
): string[] {
  if (content.length <= maxLen) return [content];

  const lines = content.split('\n');
  const pieces: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const line of lines) {
    const addLen = line.length + 1;
    if (currentLen + addLen > maxLen && current.length > 0) {
      pieces.push(current.join('\n'));
      current = [];
      currentLen = 0;
    }
    if (addLen > maxLen) {
      for (let i = 0; i < line.length; i += maxLen) {
        pieces.push(line.slice(i, i + maxLen));
      }
      continue;
    }
    current.push(line);
    currentLen += addLen;
  }
  if (current.length) pieces.push(current.join('\n'));

  let inCode = false;
  const patched = pieces.map((piece, i) => {
    const fenceCount = (piece.match(/```/g) || []).length;
    const openingFence = inCode ? '```\n' : '';
    let output = openingFence + piece;
    const stillInCodeAfter = inCode !== (fenceCount % 2 === 1);
    const closingFence = stillInCodeAfter && i < pieces.length - 1 ? '\n```' : '';
    output = output + closingFence;
    inCode = stillInCodeAfter;
    return output;
  });

  const total = patched.length;
  return patched.map((piece, i) => {
    const label = `(${i + 1}/${total})`;
    const urlLine = i === 0 && webTerminalUrl ? `\n\n📖 Full: ${webTerminalUrl}` : '';
    return `${label}\n${piece}${urlLine}`;
  });
}
