export interface ChunkOptions {
  maxChars?: number;
  overlap?: number;
}

export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const maxChars = Math.max(1, options.maxChars ?? 800);
  const overlap = Math.max(0, Math.min(options.overlap ?? 100, maxChars - 1));
  const normalized = text.replace(/\r\n/g, "\n").trim();

  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);
    if (end < normalized.length) {
      const window = normalized.slice(start, end);
      const breakAt = Math.max(
        window.lastIndexOf("\n"),
        window.lastIndexOf("。"),
        window.lastIndexOf(". "),
        window.lastIndexOf(" "),
      );
      if (breakAt > maxChars * 0.5) {
        end = start + breakAt + 1;
      }
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    if (end >= normalized.length) {
      break;
    }
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}
