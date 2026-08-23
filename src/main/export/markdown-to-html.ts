import path from 'node:path';
import { pathToFileURL } from 'node:url';
import katex from 'katex';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';

type MdNode = Record<string, any>;

interface MathPlaceholder {
  kind: 'inline' | 'block';
  value: string;
  trailingBlankLines?: number;
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath, {
  singleDollarTextMath: true,
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isLikelyMathExpression(expression: string): boolean {
  const expr = expression.trim();
  if (!expr) return false;
  if (/^[\d\s.,]+$/.test(expr)) return false;
  if (/\s/.test(expr) && !/[\\^_{}]/.test(expr) && !/[a-zA-Z0-9]\s*[=+\-*/]\s*[a-zA-Z0-9]/.test(expr)) {
    return false;
  }
  return true;
}

function normalizeMathDelimiters(markdown: string): {
  markdown: string;
  placeholders: Map<string, MathPlaceholder>;
} {
  const codePlaceholders: string[] = [];
  const mathPlaceholders = new Map<string, MathPlaceholder>();

  const protect = (pattern: RegExp, input: string): string =>
    input.replace(pattern, (match) => {
      const token = `@@EXPORT_CODE_${codePlaceholders.length}@@`;
      codePlaceholders.push(match);
      return token;
    });

  const createMathToken = (kind: 'inline' | 'block', value: string, trailingBlankLines = 0): string => {
    const token = `@@EXPORT_MATH_${mathPlaceholders.size}@@`;
    mathPlaceholders.set(token, { kind, value, ...(trailingBlankLines ? { trailingBlankLines } : {}) });
    return kind === 'block' ? `\n\n${token}\n\n` : token;
  };

  const countTrailingBlankLines = (start: number): number => {
    let index = start;
    while (normalized.startsWith('\r\n', index)) index += 2;
    while (normalized[index] === '\n') index += 1;
    const newlineCount = index - start;
    return newlineCount >= 2 && normalized.slice(index).trim() ? newlineCount - 2 : 0;
  };

  let normalized = markdown;
  normalized = protect(/```[\s\S]*?```/g, normalized);
  normalized = protect(/~~~[\s\S]*?~~~/g, normalized);
  normalized = protect(/`[^`\n]+`/g, normalized);

  // Block math: \[...\] and $$...$$
  for (const [open, close] of [
    ['\\[', '\\]'],
    ['$$', '$$'],
  ] as const) {
    let result = '';
    let cursor = 0;
    while (cursor < normalized.length) {
      if (!normalized.startsWith(open, cursor)) {
        result += normalized[cursor];
        cursor += 1;
        continue;
      }
      const closeIndex = normalized.indexOf(close, cursor + open.length);
      if (closeIndex === -1) {
        result += normalized[cursor];
        cursor += 1;
        continue;
      }
      const expression = normalized.slice(cursor + open.length, closeIndex).trim();
      const closeEnd = closeIndex + close.length;
      result += createMathToken('block', expression, countTrailingBlankLines(closeEnd));
      cursor = closeEnd;
    }
    normalized = result;
  }

  // Inline math: \(...\) then $...$
  for (const [open, close, isDollar] of [
    ['\\(', '\\)', false],
    ['$', '$', true],
  ] as const) {
    let result = '';
    let cursor = 0;
    while (cursor < normalized.length) {
      if (!normalized.startsWith(open, cursor)) {
        result += normalized[cursor];
        cursor += 1;
        continue;
      }
      if (isDollar && normalized.startsWith('$$', cursor)) {
        result += normalized[cursor];
        cursor += 1;
        continue;
      }
      if (isDollar) {
        const next = normalized[cursor + 1];
        if (!next || /\s/.test(next)) {
          result += normalized[cursor];
          cursor += 1;
          continue;
        }
      }

      const searchStart = cursor + open.length;
      let closeIndex = -1;
      for (let i = searchStart; i < normalized.length; i += 1) {
        if (normalized[i] === '\n') break;
        if (normalized.startsWith(close, i)) {
          if (isDollar && i > searchStart && /\s/.test(normalized[i - 1] ?? '')) {
            break;
          }
          closeIndex = i;
          break;
        }
      }

      if (closeIndex === -1) {
        result += normalized[cursor];
        cursor += 1;
        continue;
      }

      const expression = normalized.slice(searchStart, closeIndex).trim();
      if (!expression || (isDollar && !isLikelyMathExpression(expression))) {
        result += normalized[cursor];
        cursor += 1;
        continue;
      }

      result += createMathToken('inline', expression);
      cursor = closeIndex + close.length;
    }
    normalized = result;
  }

  normalized = normalized.replace(/@@EXPORT_CODE_(\d+)@@/g, (_m, index) => {
    return codePlaceholders[Number(index)] ?? '';
  });

  return { markdown: normalized, placeholders: mathPlaceholders };
}

function renderKatex(value: string, displayMode: boolean): string {
  try {
    return katex.renderToString(value || '\\text{?}', {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
      output: 'html',
    });
  } catch {
    return `<span class="math-error">${escapeHtml(value)}</span>`;
  }
}

function resolveImageSrc(src: string, baseDir: string | null): string {
  const trimmed = src.trim();
  if (!trimmed) return '';
  if (/^(https?:|data:|blob:|file:)/i.test(trimmed)) return trimmed;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) {
    return pathToFileURL(trimmed).toString();
  }
  if (!baseDir) return trimmed;
  return pathToFileURL(path.resolve(baseDir, trimmed)).toString();
}

function renderMathToken(token: string, placeholders: Map<string, MathPlaceholder>): string {
  const placeholder = placeholders.get(token);
  if (!placeholder) return escapeHtml(token);
  const html = renderKatex(placeholder.value, placeholder.kind === 'block');
  if (placeholder.kind === 'block') {
    const blankLines = Number(placeholder.trailingBlankLines ?? 0);
    const attrs = blankLines > 0
      ? ` data-trailing-blank-lines="${blankLines}" style="--marivell-math-blank-lines:${blankLines}"`
      : '';
    return `<div class="math-block"${attrs}>${html}</div>`;
  }
  return `<span class="math-inline">${html}</span>`;
}

function splitTextWithMath(text: string, placeholders: Map<string, MathPlaceholder>): string {
  const pattern = /@@EXPORT_MATH_\d+@@/g;
  let result = '';
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > last) {
      result += escapeHtml(text.slice(last, start));
    }
    result += renderMathToken(token, placeholders);
    last = start + token.length;
  }
  if (last < text.length) {
    result += escapeHtml(text.slice(last));
  }
  return result;
}

function isBlockMathParagraph(node: MdNode, placeholders: Map<string, MathPlaceholder>): string | null {
  if (node.type !== 'paragraph') return null;
  const children = node.children ?? [];
  if (children.length !== 1 || children[0]?.type !== 'text') return null;
  const text = String(children[0].value ?? '').trim();
  const match = text.match(/^@@EXPORT_MATH_\d+@@$/);
  if (!match) return null;
  const placeholder = placeholders.get(match[0]);
  return placeholder?.kind === 'block' ? match[0] : null;
}

function inlineToHtml(
  node: MdNode,
  placeholders: Map<string, MathPlaceholder>,
  baseDir: string | null,
): string {
  switch (node.type) {
    case 'text':
      return splitTextWithMath(String(node.value ?? ''), placeholders);
    case 'inlineCode':
      return `<code>${escapeHtml(String(node.value ?? ''))}</code>`;
    case 'break':
      return '<br />';
    case 'strong':
      return `<strong>${inlineChildrenToHtml(node.children, placeholders, baseDir)}</strong>`;
    case 'emphasis':
      return `<em>${inlineChildrenToHtml(node.children, placeholders, baseDir)}</em>`;
    case 'delete':
      return `<del>${inlineChildrenToHtml(node.children, placeholders, baseDir)}</del>`;
    case 'link': {
      const href = escapeHtml(String(node.url ?? ''));
      const title = node.title ? ` title="${escapeHtml(String(node.title))}"` : '';
      return `<a href="${href}"${title}>${inlineChildrenToHtml(node.children, placeholders, baseDir)}</a>`;
    }
    case 'image': {
      const src = escapeHtml(resolveImageSrc(String(node.url ?? ''), baseDir));
      const alt = escapeHtml(String(node.alt ?? ''));
      const title = node.title ? ` title="${escapeHtml(String(node.title))}"` : '';
      return src ? `<img src="${src}" alt="${alt}"${title} />` : '';
    }
    case 'inlineMath':
      return `<span class="math-inline">${renderKatex(String(node.value ?? ''), false)}</span>`;
    case 'footnoteReference': {
      const id = escapeHtml(String(node.identifier ?? node.label ?? ''));
      return `<sup class="footnote-ref"><a href="#fn-${id}">[${escapeHtml(String(node.label ?? node.identifier ?? ''))}]</a></sup>`;
    }
    case 'html':
      return String(node.value ?? '');
    default:
      return inlineChildrenToHtml(node.children, placeholders, baseDir);
  }
}

function inlineChildrenToHtml(
  children: MdNode[] | undefined,
  placeholders: Map<string, MathPlaceholder>,
  baseDir: string | null,
): string {
  return (children ?? []).map((child) => inlineToHtml(child, placeholders, baseDir)).join('');
}

function listItemToHtml(
  item: MdNode,
  ordered: boolean,
  placeholders: Map<string, MathPlaceholder>,
  baseDir: string | null,
): string {
  const checked = item.checked;
  const isTask = checked === true || checked === false;
  const className = isTask ? ' class="task-list-item"' : '';
  const checkbox =
    checked === true
      ? '<input type="checkbox" checked disabled /> '
      : checked === false
        ? '<input type="checkbox" disabled /> '
        : '';

  // Task items: put checkbox before first paragraph content.
  const children = item.children ?? [];
  if (isTask && children[0]?.type === 'paragraph') {
    const first = children[0];
    const rest = children.slice(1);
    const firstHtml = `<p>${checkbox}${inlineChildrenToHtml(first.children, placeholders, baseDir)}</p>`;
    const restHtml = rest
      .map((child: MdNode) => flowToHtml(child, placeholders, baseDir))
      .join('');
    return `<li${className}>${firstHtml}${restHtml}</li>`;
  }

  void ordered;
  const body = children
    .map((child: MdNode) => flowToHtml(child, placeholders, baseDir))
    .join('');
  return `<li${className}>${checkbox}${body}</li>`;
}

function flowToHtml(
  node: MdNode,
  placeholders: Map<string, MathPlaceholder>,
  baseDir: string | null,
): string {
  switch (node.type) {
    case 'paragraph': {
      const blockToken = isBlockMathParagraph(node, placeholders);
      if (blockToken) {
        return renderMathToken(blockToken, placeholders);
      }
      return `<p>${inlineChildrenToHtml(node.children, placeholders, baseDir)}</p>`;
    }
    case 'heading': {
      const level = Math.min(Math.max(Number(node.depth ?? 1), 1), 6);
      return `<h${level}>${inlineChildrenToHtml(node.children, placeholders, baseDir)}</h${level}>`;
    }
    case 'blockquote':
      return `<blockquote>${(node.children ?? []).map((c: MdNode) => flowToHtml(c, placeholders, baseDir)).join('')}</blockquote>`;
    case 'list': {
      const ordered = Boolean(node.ordered);
      const isTaskList = (node.children ?? []).some(
        (child: MdNode) => child.checked === true || child.checked === false,
      );
      const tag = ordered ? 'ol' : 'ul';
      const start =
        ordered && node.start && Number(node.start) !== 1 ? ` start="${Number(node.start)}"` : '';
      const className = isTaskList ? ' class="contains-task-list task-list"' : '';
      const items = (node.children ?? [])
        .map((item: MdNode) => listItemToHtml(item, ordered, placeholders, baseDir))
        .join('');
      return `<${tag}${start}${className}>${items}</${tag}>`;
    }
    case 'code': {
      const lang = String(node.lang ?? '').toLowerCase();
      const value = String(node.value ?? '');
      if (lang === 'mermaid') {
        return `<div class="mermaid-block"><pre class="mermaid">${escapeHtml(value)}</pre></div>`;
      }
      const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      const langAttr = lang ? ` data-language="${escapeHtml(lang)}"` : '';
      return `<pre class="code-block"${langAttr}><code${langClass}>${escapeHtml(value)}</code></pre>`;
    }
    case 'math':
      return `<div class="math-block">${renderKatex(String(node.value ?? ''), true)}</div>`;
    case 'table': {
      const rows = node.children ?? [];
      if (rows.length === 0) return '';
      const head = rows[0];
      const body = rows.slice(1);
      const renderCell = (cell: MdNode, tag: 'th' | 'td') =>
        `<${tag}>${inlineChildrenToHtml(cell.children, placeholders, baseDir)}</${tag}>`;
      const headHtml = `<thead><tr>${(head.children ?? [])
        .map((cell: MdNode) => renderCell(cell, 'th'))
        .join('')}</tr></thead>`;
      const bodyHtml = `<tbody>${body
        .map(
          (row: MdNode) =>
            `<tr>${(row.children ?? []).map((cell: MdNode) => renderCell(cell, 'td')).join('')}</tr>`,
        )
        .join('')}</tbody>`;
      return `<table>${headHtml}${bodyHtml}</table>`;
    }
    case 'thematicBreak':
      return '<hr />';
    case 'footnoteDefinition': {
      const id = escapeHtml(String(node.identifier ?? node.label ?? ''));
      const body = (node.children ?? [])
        .map((child: MdNode) => flowToHtml(child, placeholders, baseDir))
        .join('');
      return `<div class="footnote-item" id="fn-${id}"><sup>[${escapeHtml(String(node.label ?? node.identifier ?? ''))}]</sup> ${body}</div>`;
    }
    case 'html':
      return String(node.value ?? '');
    case 'definition':
      return '';
    default:
      return (node.children ?? [])
        .map((child: MdNode) => flowToHtml(child, placeholders, baseDir))
        .join('');
  }
}

export interface MarkdownToHtmlOptions {
  markdown: string;
  baseDir?: string | null;
  title?: string;
}

export function markdownToExportHtmlFragment(options: MarkdownToHtmlOptions): string {
  const { markdown, baseDir = null } = options;
  const normalized = normalizeMathDelimiters(markdown);
  const tree = parser.parse(normalized.markdown) as MdNode;
  const children = tree.children ?? [];

  const footnotes: MdNode[] = [];
  const bodyNodes: MdNode[] = [];
  for (const child of children) {
    if (child.type === 'footnoteDefinition') {
      footnotes.push(child);
    } else if (child.type !== 'definition') {
      bodyNodes.push(child);
    }
  }

  const body = bodyNodes.map((node) => flowToHtml(node, normalized.placeholders, baseDir)).join('\n');
  const footnoteHtml =
    footnotes.length > 0
      ? `<section class="footnotes"><h2>脚注</h2>${footnotes
          .map((node) => flowToHtml(node, normalized.placeholders, baseDir))
          .join('')}</section>`
      : '';

  return `${body}${footnoteHtml}`;
}
