import type { FolderEntry } from '@shared/contracts';

export interface OutlineItem {
  id: string;
  level: number;
  text: string;
  /** 0-based line index in the source markdown. */
  line: number;
  /**
   * Character offset of the start of the heading line in the original
   * markdown string (accounts for `\n` and `\r\n` line endings).
   */
  start: number;
}

export function getDirectoryPath(filePath: string | null): string | null {
  if (!filePath) {
    return null;
  }

  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? null : filePath.slice(0, index);
}

/**
 * Extract ATX headings for the outline panel.
 * Skips content inside fenced code blocks so ``` examples do not pollute the outline.
 * Offsets are computed on the original string so CRLF documents stay accurate.
 */
export function extractOutline(markdown: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  let fenceMarker: string | null = null;
  let lineIndex = 0;
  let cursor = 0;

  while (cursor <= markdown.length) {
    const lineStart = cursor;

    // Consume until end of line (exclusive of line ending).
    let lineEnd = cursor;
    while (lineEnd < markdown.length) {
      const ch = markdown[lineEnd];
      if (ch === '\n' || ch === '\r') {
        break;
      }
      lineEnd += 1;
    }

    const line = markdown.slice(lineStart, lineEnd);

    if (fenceMarker) {
      if (line.startsWith(fenceMarker) && line.trim() === fenceMarker) {
        fenceMarker = null;
      }
    } else {
      const fenceOpen = /^(```|~~~)/.exec(line);
      if (fenceOpen) {
        fenceMarker = fenceOpen[1] ?? null;
      } else {
        // Only ATX headings at line start (allow up to 3 leading spaces per CommonMark).
        const match = /^( {0,3})(#{1,6})\s+(.+?)\s*$/.exec(line);
        if (match) {
          items.push({
            id: `heading-${lineIndex}-${items.length}`,
            level: match[2]!.length,
            text: match[3]!,
            line: lineIndex,
            start: lineStart,
          });
        }
      }
    }

    if (lineEnd >= markdown.length) {
      break;
    }

    // Advance past the actual line ending: \r\n, \n, or lone \r.
    if (markdown[lineEnd] === '\r' && markdown[lineEnd + 1] === '\n') {
      cursor = lineEnd + 2;
    } else {
      cursor = lineEnd + 1;
    }
    lineIndex += 1;
  }

  return items;
}

export function formatFolderDate(timestamp: number): string {
  const now = Date.now();
  const diffDays = Math.floor((now - timestamp) / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) {
    return '\u4eca\u5929';
  }

  if (diffDays === 1) {
    return '\u6628\u5929';
  }

  if (diffDays < 7) {
    return `${diffDays} \u5929\u524d`;
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
  }).format(timestamp);
}

export function sortFolderEntries(entries: FolderEntry[]): FolderEntry[] {
  return [...entries].sort((left, right) => right.modifiedAt - left.modifiedAt);
}
