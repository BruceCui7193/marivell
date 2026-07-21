/**
 * Lightweight Markdown syntax highlighter for the source editor.
 * Fast enough for live typing (line-oriented regex, no full AST).
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function span(className: string, text: string): string {
  return `<span class="md-token md-token--${className}">${escapeHtml(text)}</span>`;
}

function highlightGenericCode(code: string): string {
  const rules: Array<{ name: string; re: RegExp }> = [
    { name: 'comment', re: /\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*/y },
    { name: 'string', re: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/y },
    { name: 'number', re: /\b\d+(?:\.\d+)?\b/y },
    {
      name: 'keyword',
      re: /\b(?:const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|new|try|catch|throw|switch|case|break|continue|typeof|interface|type|public|private|protected|def|fn|struct|enum|package|func|match|impl|use|pub|mut|self|True|False|None|null|undefined|true|false)\b/y,
    },
  ];

  let out = '';
  let i = 0;
  while (i < code.length) {
    let matched = false;
    for (const rule of rules) {
      rule.re.lastIndex = i;
      const m = rule.re.exec(code);
      if (m && m.index === i) {
        out += span(rule.name, m[0]);
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += escapeHtml(code[i] ?? '');
      i += 1;
    }
  }
  return out;
}

function highlightInlineSegment(plain: string): string {
  if (!plain) {
    return '';
  }

  const parts: string[] = [];
  let i = 0;
  let buf = '';

  const flush = () => {
    if (buf) {
      parts.push(escapeHtml(buf));
      buf = '';
    }
  };

  while (i < plain.length) {
    if (plain[i] === '$' && plain[i + 1] !== '$') {
      const close = plain.indexOf('$', i + 1);
      if (close !== -1 && close > i + 1) {
        flush();
        parts.push(span('math', plain.slice(i, close + 1)));
        i = close + 1;
        continue;
      }
    }

    if (plain.startsWith('\\(', i)) {
      const close = plain.indexOf('\\)', i + 2);
      if (close !== -1) {
        flush();
        parts.push(span('math', plain.slice(i, close + 2)));
        i = close + 2;
        continue;
      }
    }

    if (plain.startsWith('![', i)) {
      const m = plain.slice(i).match(/^!\[[^\]]*]\([^)]*\)/);
      if (m) {
        flush();
        parts.push(span('image', m[0]));
        i += m[0].length;
        continue;
      }
    }

    if (plain[i] === '[') {
      const m = plain.slice(i).match(/^\[[^\]]*]\([^)]*\)/);
      if (m) {
        flush();
        parts.push(span('link', m[0]));
        i += m[0].length;
        continue;
      }
    }

    if (plain.startsWith('**', i) || plain.startsWith('__', i)) {
      const delim = plain.slice(i, i + 2);
      const close = plain.indexOf(delim, i + 2);
      if (close !== -1) {
        flush();
        parts.push(span('strong', plain.slice(i, close + 2)));
        i = close + 2;
        continue;
      }
    }

    if (plain.startsWith('~~', i)) {
      const close = plain.indexOf('~~', i + 2);
      if (close !== -1) {
        flush();
        parts.push(span('strike', plain.slice(i, close + 2)));
        i = close + 2;
        continue;
      }
    }

    if ((plain[i] === '*' || plain[i] === '_') && plain[i + 1] !== plain[i]) {
      const delim = plain[i]!;
      const close = plain.indexOf(delim, i + 1);
      if (close !== -1 && close > i + 1) {
        flush();
        parts.push(span('emphasis', plain.slice(i, close + 1)));
        i = close + 1;
        continue;
      }
    }

    if (plain[i] === '`') {
      const close = plain.indexOf('`', i + 1);
      if (close !== -1) {
        flush();
        parts.push(span('code', plain.slice(i, close + 1)));
        i = close + 1;
        continue;
      }
    }

    if (plain.startsWith('[^', i)) {
      const m = plain.slice(i).match(/^\[\^[^\]]+]/);
      if (m) {
        flush();
        parts.push(span('footnote', m[0]));
        i += m[0].length;
        continue;
      }
    }

    buf += plain[i];
    i += 1;
  }

  flush();
  return parts.join('');
}

/**
 * Highlight full Markdown source into HTML.
 * Newlines are preserved so the overlay stays pixel-aligned with the textarea.
 */
export function highlightMarkdownSource(markdown: string): string {
  if (!markdown) {
    return '\n';
  }

  const lines = markdown.split('\n');
  const out: string[] = [];
  let fenceMarker: string | null = null;
  let fenceLang = '';

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    const trailing = lineIndex < lines.length - 1 || markdown.endsWith('\n') ? '\n' : '';

    if (fenceMarker) {
      if (line.startsWith(fenceMarker) && line.trim() === fenceMarker) {
        out.push(span('fence', line));
        fenceMarker = null;
        fenceLang = '';
      } else {
        out.push(`<span class="md-token md-token--codeblock">${highlightGenericCode(line)}</span>`);
      }
      out.push(trailing);
      continue;
    }

    const fenceOpen = line.match(/^(```|~~~)([^\s`]*)$/);
    if (fenceOpen) {
      fenceMarker = fenceOpen[1]!;
      fenceLang = fenceOpen[2] ?? '';
      void fenceLang;
      out.push(span('fence', line));
      out.push(trailing);
      continue;
    }

    const heading = line.match(/^(#{1,6})(\s+)(.*)$/);
    if (heading) {
      out.push(
        `${span('heading-marker', heading[1]!)}${escapeHtml(heading[2]!)}${highlightInlineSegment(heading[3]!)}`,
      );
      out.push(trailing);
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const m = line.match(/^( {0,3}>)(\s?)(.*)$/);
      if (m) {
        out.push(
          `${span('quote-marker', m[1]!)}${escapeHtml(m[2] ?? '')}${highlightInlineSegment(m[3] ?? '')}`,
        );
        out.push(trailing);
        continue;
      }
    }

    if (/^\s*\|.+\|/.test(line) || /^\s*\|?\s*:?-{3,}/.test(line)) {
      out.push(span('table', line));
      out.push(trailing);
      continue;
    }

    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(span('hr', line));
      out.push(trailing);
      continue;
    }

    const task = line.match(/^(\s*)([-*+]|\d+\.)(\s+)(\[[ xX]\])(\s+)(.*)$/);
    if (task) {
      out.push(
        `${escapeHtml(task[1]!)}${span('list-marker', task[2]!)}${escapeHtml(task[3]!)}${span('task', task[4]!)}${escapeHtml(task[5]!)}${highlightInlineSegment(task[6]!)}`,
      );
      out.push(trailing);
      continue;
    }

    const list = line.match(/^(\s*)([-*+]|\d+\.)(\s+)(.*)$/);
    if (list) {
      out.push(
        `${escapeHtml(list[1]!)}${span('list-marker', list[2]!)}${escapeHtml(list[3]!)}${highlightInlineSegment(list[4]!)}`,
      );
      out.push(trailing);
      continue;
    }

    if (/^\[\^[^\]]+]:/.test(line)) {
      out.push(span('footnote', line));
      out.push(trailing);
      continue;
    }

    if (/^ {0,3}(?:\$\$|\\\[|\\\])/.test(line)) {
      out.push(span('math', line));
      out.push(trailing);
      continue;
    }

    out.push(highlightInlineSegment(line));
    out.push(trailing);
  }

  return out.join('') || '\n';
}

/** Convert caret offset to 1-based line/column. */
export function offsetToLineCol(text: string, offset: number): { line: number; column: number } {
  const safe = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let column = 1;
  for (let i = 0; i < safe; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}
