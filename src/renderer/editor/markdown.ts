import type { JSONContent } from '@tiptap/core';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';

type MarkdownNode = Record<string, any>;

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath, { singleDollarTextMath: true });

interface DefinitionContext {
  definitions: Map<string, MarkdownNode>;
}

interface MathPlaceholder {
  kind: 'inline' | 'block';
  value: string;
  openDelim: string;
  closeDelim: string;
  raw?: string;
  trailingBlankLines?: number;
}

function normalizeMathDelimiters(markdown: string): {
  markdown: string;
  placeholders: Map<string, MathPlaceholder>;
} {
  const mathPlaceholders = new Map<string, MathPlaceholder>();
  const codePlaceholders: string[] = [];

  let nonce = Math.random().toString(36).slice(2, 10);
  let tokenPrefix = `\uE000MDMATH_${nonce}_`;
  while (markdown.includes(tokenPrefix) || markdown.includes('\uE001')) {
    nonce = Math.random().toString(36).slice(2, 10);
    tokenPrefix = `\uE000MDMATH_${nonce}_`;
  }

  let codeNonce = Math.random().toString(36).slice(2, 10);
  let codeTokenPrefix = `\uE000MDCODE_${codeNonce}_`;
  while (markdown.includes(codeTokenPrefix) || markdown.includes('\uE002')) {
    codeNonce = Math.random().toString(36).slice(2, 10);
    codeTokenPrefix = `\uE000MDCODE_${codeNonce}_`;
  }

  const protectCode = (pattern: RegExp, input: string): string =>
    input.replace(pattern, (match) => {
      const token = `${codeTokenPrefix}${codePlaceholders.length}\uE002`;
      codePlaceholders.push(match);
      return token;
    });

  const protectFencedCodeBlocks = (input: string, fenceChar: '`' | '~'): string => {
    const lines = input.split('\n');
    const openingPattern = fenceChar === '`' ? /^( {0,3})(`{3,})/ : /^( {0,3})(~{3,})/;
    const closingPattern =
      fenceChar === '`' ? /^( {0,3})(`{3,})\s*$/ : /^( {0,3})(~{3,})\s*$/;
    const result: string[] = [];
    let index = 0;

    while (index < lines.length) {
      const line = lines[index] ?? '';
      const opening = line.match(openingPattern);
      if (!opening) {
        result.push(line);
        index += 1;
        continue;
      }

      const fenceLength = opening[2]!.length;
      const start = index;
      let end = index + 1;
      let closed = false;
      while (end < lines.length) {
        const closing = (lines[end] ?? '').match(closingPattern);
        if (closing && closing[2]!.length >= fenceLength) {
          closed = true;
          end += 1;
          break;
        }
        end += 1;
      }

      if (!closed) {
        result.push(line);
        index += 1;
        continue;
      }

      const block = lines.slice(start, end).join('\n');
      const token = `${codeTokenPrefix}${codePlaceholders.length}\uE002`;
      codePlaceholders.push(block);
      result.push(token);
      index = end;
    }

    return result.join('\n');
  };

  const protectIndentedCodeBlocks = (input: string): string => {
    const lines = input.split('\n');
    const isIndentedCodeLine = (line: string) => /^(?: {4}|\t)/.test(line);
    let index = 0;

    while (index < lines.length) {
      const previous = index === 0 ? '' : lines[index - 1] ?? '';
      if (isIndentedCodeLine(lines[index] ?? '') && previous.trim() === '') {
        const start = index;
        let end = index;
        let sawCode = false;

        while (end < lines.length) {
          const line = lines[end] ?? '';
          if (line.trim() === '') {
            end += 1;
            continue;
          }
          if (!isIndentedCodeLine(line)) {
            break;
          }
          sawCode = true;
          end += 1;
        }

        if (sawCode) {
          const blockEnd = end - 1;
          const block = lines.slice(start, blockEnd + 1).join('\n');
          const token = `${codeTokenPrefix}${codePlaceholders.length}\uE002`;
          codePlaceholders.push(block);
          lines.splice(start, blockEnd - start + 1, token);
          index = start + 1;
          continue;
        }
      }

      index += 1;
    }

    return lines.join('\n');
  };

  const createMathToken = (
    kind: 'inline' | 'block',
    value: string,
    openDelim: string,
    closeDelim: string,
    rawSource?: string,
    trailingBlankLines?: number,
  ): string => {
    const token = `${tokenPrefix}${mathPlaceholders.size}\uE001`;
    mathPlaceholders.set(token, {
      kind,
      value,
      openDelim,
      closeDelim,
      raw: rawSource,
      ...(trailingBlankLines ? { trailingBlankLines } : {}),
    });
    return token;
  };

  let normalized = markdown;
  normalized = protectFencedCodeBlocks(normalized, '`');
  normalized = protectFencedCodeBlocks(normalized, '~');
  normalized = protectCode(/`[^`\n]+`/g, normalized);
  normalized = protectIndentedCodeBlocks(normalized);
  normalized = normalizeBlockMathInBlockQuotes(normalized, '$$', '$$', createMathToken, '$$', '$$');
  normalized = normalizeBlockMathInBlockQuotes(normalized, '\\[', '\\]', createMathToken, '\\[', '\\]');
  normalized = normalizeBlockMathPairs(normalized, '\\[', '\\]', createMathToken, '\\[', '\\]');
  normalized = normalizeBlockMathPairs(normalized, '$$', '$$', createMathToken, '$$', '$$');
  normalized = normalizeInlineMathPairs(normalized, '\\(', '\\)', createMathToken, '\\(', '\\)');
  normalized = normalizeInlineMathPairs(normalized, '$', '$', createMathToken, '$', '$');

  let restored = normalized;
  let restorePasses = 0;
  while (restored.includes(codeTokenPrefix)) {
    for (let index = 0; index < codePlaceholders.length; index += 1) {
      restored = restored
        .split(`${codeTokenPrefix}${index}\uE002`)
        .join(codePlaceholders[index] ?? '');
    }
    restorePasses += 1;
    if (restorePasses > 100) {
      break;
    }
  }

  return {
    markdown: restored,
    placeholders: mathPlaceholders,
  };
}

function normalizeBlockMathPairs(
  markdown: string,
  open: string,
  close: string,
  createMathToken: (
    kind: 'inline' | 'block',
    value: string,
    openDelim: string,
    closeDelim: string,
    rawSource?: string,
    trailingBlankLines?: number,
  ) => string,
  openDelim: string,
  closeDelim: string,
): string {
  const isImmediatelyFollowedByBlockMath = (start: number): boolean => {
    let index = start;
    if (markdown.startsWith('\r\n', index)) {
      index += 2;
    } else if (markdown[index] === '\n') {
      index += 1;
    } else {
      return false;
    }

    while (markdown[index] === ' ' || markdown[index] === '\t') {
      index += 1;
    }
    return markdown.startsWith(open, index);
  };

  const countTrailingBlankLines = (start: number): number => {
    let index = start;
    while (markdown.startsWith('\r\n', index)) {
      index += 2;
    }
    while (markdown[index] === '\n') {
      index += 1;
    }
    const newlineCount = index - start;
    const hasFollowingContent = markdown.slice(index).trim().length > 0;
    return newlineCount >= 2 && hasFollowingContent ? newlineCount - 2 : 0;
  };

  let result = '';
  let cursor = 0;

  while (cursor < markdown.length) {
    if (!markdown.startsWith(open, cursor)) {
      result += markdown[cursor];
      cursor += 1;
      continue;
    }

    const closeIndex = markdown.indexOf(close, cursor + open.length);
    if (closeIndex === -1) {
      result += markdown[cursor];
      cursor += 1;
      continue;
    }

    const expression = markdown.slice(cursor + open.length, closeIndex).trim();
    const closeEnd = closeIndex + close.length;
    const separateFromNext = isImmediatelyFollowedByBlockMath(closeEnd);
    const trailingBlankLines = separateFromNext ? 0 : countTrailingBlankLines(closeEnd);
    const token = createMathToken(
      'block',
      expression,
      openDelim,
      closeDelim,
      markdown.slice(cursor, closeIndex + close.length),
      trailingBlankLines,
    );
    const nextIndex = closeEnd;
    result += separateFromNext ? `${token}\n\n` : token;
    if (separateFromNext && markdown.startsWith('\r\n', nextIndex)) {
      cursor = nextIndex + 2;
    } else if (separateFromNext && markdown[nextIndex] === '\n') {
      cursor = nextIndex + 1;
    } else {
      cursor = nextIndex;
    }
  }

  return result;
}

function normalizeBlockMathInBlockQuotes(
  markdown: string,
  open: string,
  close: string,
  createMathToken: (
    kind: 'inline' | 'block',
    value: string,
    openDelim: string,
    closeDelim: string,
    rawSource?: string,
  ) => string,
  openDelim: string,
  closeDelim: string,
): string {
  const parseQuoteLine = (line: string) => {
    const match = line.match(/^([ \t]*(?:>[ \t]?)+)(.*)$/);
    return match ? { quote: match[1]!, content: match[2]!.trim() } : null;
  };

  const hadTrailingNewline = /\r?\n$/.test(markdown);
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const result: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const opening = parseQuoteLine(lines[index] ?? '');
    if (!opening || opening.content !== open) {
      result.push(lines[index] ?? '');
      index += 1;
      continue;
    }

    const startIndex = index;
    let closeIndex = -1;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const quoted = parseQuoteLine(lines[scan] ?? '');
      if (!quoted) break;
      if (quoted.content === close) {
        closeIndex = scan;
        break;
      }
    }

    if (closeIndex === -1) {
      result.push(lines[index] ?? '');
      index += 1;
      continue;
    }

    const expression = lines
      .slice(startIndex + 1, closeIndex)
      .map((line) => parseQuoteLine(line)?.content ?? '')
      .join('\n')
      .trim();
    const token = createMathToken('block', expression, openDelim, closeDelim);
    const replacement = `${opening.quote}${/\s$/.test(opening.quote) ? '' : ' '}${token}`;
    result.push(replacement);
    index = closeIndex + 1;
  }

  return result.join('\n') + (hadTrailingNewline ? '\n' : '');
}

/**
 * Heuristic to avoid treating currency / plain numbers as math.
 * Accepts LaTeX-ish content ($E=mc^2$, $\alpha$, $x_1$) while rejecting
 * patterns like `$5 and $10` or `$99.99$`.
 */
function isLikelyMathExpression(expression: string): boolean {
  const expr = expression.trim();
  if (!expr) {
    return false;
  }

  // Pure numeric / currency-like amounts
  if (/^[\d\s.,]+$/.test(expr)) {
    return false;
  }

  // Prose with spaces but no LaTeX operators → almost certainly not math
  // (e.g. "5 and" from the false pair `$5 and $10`)
  if (/\s/.test(expr) && !/[\\^_{}]/.test(expr) && !/[a-zA-Z0-9]\s*[=+\-*/]\s*[a-zA-Z0-9]/.test(expr)) {
    return false;
  }

  return true;
}

function normalizeInlineMathPairs(
  markdown: string,
  open: string,
  close: string,
  createMathToken: (
    kind: 'inline' | 'block',
    value: string,
    openDelim: string,
    closeDelim: string,
    rawSource?: string,
  ) => string,
  openDelim: string,
  closeDelim: string,
): string {
  let result = '';
  let cursor = 0;

  while (cursor < markdown.length) {
    if (!markdown.startsWith(open, cursor)) {
      result += markdown[cursor];
      cursor += 1;
      continue;
    }

    if (open === '$' && markdown.startsWith('$$', cursor)) {
      result += markdown[cursor];
      cursor += 1;
      continue;
    }

    // `$` math must not start with whitespace (avoids `$ 5$` oddities and
    // reduces accidental pairs in prose).
    if (open === '$') {
      const next = markdown[cursor + open.length];
      if (!next || /\s/.test(next)) {
        result += markdown[cursor];
        cursor += 1;
        continue;
      }
    }

    const searchStart = cursor + open.length;
    const closeIndex = findInlineMathClose(markdown, searchStart, close);
    if (closeIndex === -1) {
      result += markdown[cursor];
      cursor += 1;
      continue;
    }

    // Closing `$` must not be preceded by whitespace.
    if (open === '$' && closeIndex > searchStart && /\s/.test(markdown[closeIndex - 1] ?? '')) {
      result += markdown[cursor];
      cursor += 1;
      continue;
    }

    const rawExpression = markdown.slice(searchStart, closeIndex);
    const expression = rawExpression.trim();
    if (!expression) {
      result += markdown[cursor];
      cursor += 1;
      continue;
    }

    // Only apply currency/prose heuristics for single-dollar delimiters.
    // `\(...\)` is unambiguous and should always be treated as math.
    if (open === '$' && !isLikelyMathExpression(expression)) {
      result += markdown[cursor];
      cursor += 1;
      continue;
    }

    result += createMathToken(
      'inline',
      expression,
      openDelim,
      closeDelim,
      markdown.slice(cursor, closeIndex + close.length),
    );
    cursor = closeIndex + close.length;
  }

  return result;
}

function findInlineMathClose(markdown: string, cursor: number, close: string): number {
  let index = cursor;

  while (index < markdown.length) {
    if (markdown[index] === '\n') {
      return -1;
    }

    if (markdown.startsWith(close, index)) {
      return index;
    }

    index += 1;
  }

  return -1;
}

function hasMathPlaceholderToken(value: string): boolean {
  return value.includes('\uE001') || value.includes('\uE000MDMATH_');
}

function splitTextWithMathPlaceholders(
  text: string,
  placeholders: Map<string, MathPlaceholder>,
): JSONContent[] {
  if (!hasMathPlaceholderToken(text)) {
    return text ? [{ type: 'text', text }] : [];
  }

  const tokens = [...placeholders.keys()].sort((a, b) => b.length - a.length);
  const parts: JSONContent[] = [];
  let lastIndex = 0;

  while (lastIndex < text.length) {
    let nextIndex = -1;
    let nextToken = '';
    for (const token of tokens) {
      const index = text.indexOf(token, lastIndex);
      if (index !== -1 && (nextIndex === -1 || index < nextIndex)) {
        nextIndex = index;
        nextToken = token;
      }
    }
    if (nextIndex === -1) {
      break;
    }

    if (nextIndex > lastIndex) {
      parts.push({
        type: 'text',
        text: text.slice(lastIndex, nextIndex),
      });
    }

    const placeholder = placeholders.get(nextToken);
    if (placeholder) {
      parts.push({
        type: 'inlineMath',
        attrs: {
          display: placeholder.kind === 'block' ? 'yes' : 'no',
          openDelim: placeholder.openDelim,
          closeDelim: placeholder.closeDelim,
        },
        content: placeholder.value ? [{ type: 'text', text: placeholder.value }] : undefined,
      });
    }

    lastIndex = nextIndex + nextToken.length;
  }

  if (lastIndex < text.length) {
    parts.push({
      type: 'text',
      text: text.slice(lastIndex),
    });
  }

  return parts;
}

function getBlockMathPlaceholder(node: MarkdownNode, placeholders: Map<string, MathPlaceholder>): MathPlaceholder | null {
  if (node.type !== 'paragraph') {
    return null;
  }

  const children = node.children ?? [];
  if (children.length !== 1 || children[0]?.type !== 'text') {
    return null;
  }

  // Use regex to extract the math token, so surrounding text
  // (e.g. selection markers) doesn't break the lookup.
  const text = String(children[0].value ?? '').trim();
  if (!hasMathPlaceholderToken(text)) {
    return null;
  }

  const token = [...placeholders.keys()].find((candidate) => text.includes(candidate));
  if (!token) {
    return null;
  }

  const placeholder = placeholders.get(token);
  return placeholder?.kind === 'block' ? placeholder : null;
}

function restoreLeakedMathText(value: string, placeholders: Map<string, MathPlaceholder>): string {
  if (!hasMathPlaceholderToken(value)) {
    return value;
  }

  let restored = value;
  for (const [token, placeholder] of placeholders) {
    restored = restored.split(token).join(
      placeholder.raw ??
        `${placeholder.openDelim}${placeholder.value}${placeholder.closeDelim}`,
    );
  }
  return restored;
}

function restoreLeakedMathTokens(
  content: JSONContent[],
  placeholders: Map<string, MathPlaceholder>,
): JSONContent[] {
  return content.map((node) => {
    let next = node;

    if (node.type === 'text' && typeof node.text === 'string') {
      const restored = restoreLeakedMathText(node.text, placeholders);
      if (restored !== node.text) {
        next = { ...next, text: restored };
      }
    }

    if (node.attrs && typeof node.attrs === 'object') {
      const attrs: Record<string, unknown> = { ...node.attrs };
      let changed = false;
      for (const key of ['html', 'code', 'value', 'latex']) {
        const value = attrs[key];
        if (typeof value === 'string') {
          const restored = restoreLeakedMathText(value, placeholders);
          if (restored !== value) {
            attrs[key] = restored;
            changed = true;
          }
        }
      }
      if (changed) {
        next = { ...next, attrs };
      }
    }

    if (Array.isArray(next.content)) {
      next = {
        ...next,
        content: restoreLeakedMathTokens(next.content, placeholders),
      };
    }

    return next;
  });
}

function collectDefinitions(root: MarkdownNode): DefinitionContext {
  const definitions = new Map<string, MarkdownNode>();

  for (const child of root.children ?? []) {
    if (child.type === 'definition' && child.identifier) {
      definitions.set(String(child.identifier).toLowerCase(), child);
    }
  }

  return { definitions };
}

function markify(
  content: JSONContent[],
  mark: NonNullable<JSONContent['marks']>[number],
): JSONContent[] {
  return content.map((node) => {
    if (node.type === 'text') {
      const existingMarks = node.marks ?? [];
      // Skip if this mark type is already present — prevents duplicate marks
      // from nested same-type emphasis (e.g. **outer **inner** outer**)
      if (existingMarks.some((m) => m.type === mark.type)) {
        return node;
      }

      return {
        ...node,
        marks: [...existingMarks, mark],
      };
    }

    return node;
  });
}

function inlineChildrenToTiptap(
  children: MarkdownNode[],
  context: DefinitionContext,
  mathPlaceholders: Map<string, MathPlaceholder>,
): JSONContent[] {
  return children.flatMap((child) => inlineToTiptap(child, context, mathPlaceholders));
}

function inlineToTiptap(
  node: MarkdownNode,
  context: DefinitionContext,
  mathPlaceholders: Map<string, MathPlaceholder>,
): JSONContent[] {
  switch (node.type) {
    case 'text':
      return node.value ? splitTextWithMathPlaceholders(String(node.value), mathPlaceholders) : [];
    case 'inlineCode':
      return node.value
        ? [
            {
              type: 'text',
              text: String(node.value),
              marks: [{ type: 'code' }],
            },
          ]
        : [];
    case 'break':
      return [{ type: 'hardBreak' }];
    case 'strong':
      return markify(inlineChildrenToTiptap(node.children ?? [], context, mathPlaceholders), { type: 'bold' });
    case 'emphasis':
      return markify(inlineChildrenToTiptap(node.children ?? [], context, mathPlaceholders), { type: 'italic' });
    case 'delete':
      return markify(inlineChildrenToTiptap(node.children ?? [], context, mathPlaceholders), { type: 'strike' });
    case 'link':
      return markify(inlineChildrenToTiptap(node.children ?? [], context, mathPlaceholders), {
        type: 'link',
        attrs: {
          href: node.url,
          title: node.title ?? null,
        },
      });
    case 'linkReference': {
      const definition = context.definitions.get(String(node.identifier).toLowerCase());
      if (!definition) {
        return [{ type: 'text', text: String(node.label ?? node.identifier ?? '') }];
      }

      return markify(inlineChildrenToTiptap(node.children ?? [], context, mathPlaceholders), {
        type: 'link',
        attrs: {
          href: definition.url,
          title: definition.title ?? null,
        },
      });
    }
    case 'image':
      return [
        {
          type: 'image',
          attrs: {
            src: node.url,
            alt: node.alt ?? '',
            title: node.title ?? null,
          },
        },
      ];
    case 'imageReference': {
      const definition = context.definitions.get(String(node.identifier).toLowerCase());
      if (!definition) {
        return [];
      }

      return [
        {
          type: 'image',
          attrs: {
            src: definition.url,
            alt: node.alt ?? node.identifier ?? '',
            title: definition.title ?? null,
          },
        },
      ];
    }
    case 'inlineMath':
      return [
        {
          type: 'inlineMath',
          attrs: {
            display: 'no',
          },
          content: node.value ? [{ type: 'text', text: String(node.value) }] : undefined,
        },
      ];
    case 'footnoteReference':
      return [
        {
          type: 'footnoteReference',
          attrs: {
            label: String(node.label ?? node.identifier ?? ''),
          },
        },
      ];
    case 'html':
      return [{ type: 'text', text: String(node.value) }];
    default:
      return [];
  }
}

function tableCellToNode(
  cell: MarkdownNode,
  type: 'tableCell' | 'tableHeader',
  context: DefinitionContext,
  mathPlaceholders: Map<string, MathPlaceholder>,
): JSONContent {
  const content = inlineChildrenToTiptap(cell.children ?? [], context, mathPlaceholders);

  return {
    type,
    content: [
      {
        type: 'paragraph',
        content,
      },
    ],
  };
}

function flowChildrenToTiptap(
  children: MarkdownNode[],
  context: DefinitionContext,
  mathPlaceholders: Map<string, MathPlaceholder>,
): JSONContent[] {
  return children
    .filter((child) => child.type !== 'definition')
    .flatMap((child) => flowToTiptap(child, context, mathPlaceholders));
}

function flowToTiptap(
  node: MarkdownNode,
  context: DefinitionContext,
  mathPlaceholders: Map<string, MathPlaceholder>,
): JSONContent[] {
  switch (node.type) {
    case 'paragraph': {
      const blockMathPH = getBlockMathPlaceholder(node, mathPlaceholders);
      if (blockMathPH !== null) {
        return [
          {
            type: 'inlineMath',
            attrs: {
              display: 'yes',
              openDelim: blockMathPH.openDelim,
              closeDelim: blockMathPH.closeDelim,
              trailingBlankLines: blockMathPH.trailingBlankLines ?? 0,
            },
            content: blockMathPH.value ? [{ type: 'text', text: blockMathPH.value }] : undefined,
          },
        ];
      }

      const content = inlineChildrenToTiptap(node.children ?? [], context, mathPlaceholders);

      return [{ type: 'paragraph', content }];
    }
    case 'heading':
      return [
        {
          type: 'heading',
          attrs: { level: node.depth ?? 1 },
          content: inlineChildrenToTiptap(node.children ?? [], context, mathPlaceholders),
        },
      ];
    case 'blockquote':
      return [
        {
          type: 'blockquote',
          content: flowChildrenToTiptap(node.children ?? [], context, mathPlaceholders),
        },
      ];
    case 'list': {
      // CommonMark treats bullets and GFM task checkboxes as one list kind.
      // Our editor models them separately, so split mixed runs instead of
      // turning every item beside a checkbox into a task item.
      const children = node.children ?? [];
      const result: JSONContent[] = [];
      let index = 0;
      while (index < children.length) {
        const isTaskRun = children[index]!.checked !== null && children[index]!.checked !== undefined;
        const runStart = index;
        const run: MarkdownNode[] = [];
        while (
          index < children.length &&
          ((children[index]!.checked !== null && children[index]!.checked !== undefined) === isTaskRun)
        ) {
          run.push(children[index]!);
          index += 1;
        }

        result.push({
          type: isTaskRun ? 'taskList' : node.ordered ? 'orderedList' : 'bulletList',
          attrs: !isTaskRun && node.ordered ? { start: (node.start ?? 1) + runStart } : undefined,
          content: run.map((child: MarkdownNode) => ({
            type: isTaskRun ? 'taskItem' : 'listItem',
            attrs: isTaskRun ? { checked: Boolean(child.checked) } : undefined,
            content: flowChildrenToTiptap(child.children ?? [], context, mathPlaceholders),
          })),
        });
      }

      return result;
    }
    case 'code':
      if (String(node.lang ?? '').toLowerCase() === 'mermaid') {
        return [
          {
            type: 'mermaidBlock',
            attrs: {
              code: String(node.value ?? ''),
            },
          },
        ];
      }

      return [
        {
          type: 'codeBlock',
          attrs: {
            language: node.lang ?? null,
          },
          content: node.value ? [{ type: 'text', text: String(node.value) }] : [],
        },
      ];
    case 'math':
      return [
        {
          type: 'inlineMath',
          attrs: {
            latex: String(node.value ?? ''),
            display: 'yes',
          },
        },
      ];
    case 'table':
      return [
        {
          type: 'table',
          content: (node.children ?? []).map((row: MarkdownNode, index: number) => ({
            type: 'tableRow',
            content: (row.children ?? []).map((cell: MarkdownNode) =>
              tableCellToNode(
                cell,
                index === 0 ? 'tableHeader' : 'tableCell',
                context,
                mathPlaceholders,
              ),
            ),
          })),
        },
      ];
    case 'thematicBreak':
      return [{ type: 'horizontalRule' }];
    case 'footnoteDefinition':
      return [
        {
          type: 'footnoteDefinition',
          attrs: {
            label: String(node.label ?? node.identifier ?? ''),
          },
          content: flowChildrenToTiptap(node.children ?? [], context, mathPlaceholders),
        },
      ];
    case 'html':
      return [
        {
          type: 'htmlBlock',
          attrs: {
            html: String(node.value ?? ''),
          },
        },
      ];
    default:
      return [];
  }
}

function applyTextMarks(text: string, marks: NonNullable<JSONContent['marks']> = []): MarkdownNode {
  const codeMark = marks.find((mark) => mark.type === 'code');
  if (codeMark) {
    return { type: 'inlineCode', value: text };
  }

  let current: MarkdownNode = { type: 'text', value: text };
  for (const mark of marks) {
    if (mark.type === 'bold') {
      current = { type: 'strong', children: [current] };
    } else if (mark.type === 'italic') {
      current = { type: 'emphasis', children: [current] };
    } else if (mark.type === 'strike') {
      current = { type: 'delete', children: [current] };
    } else if (mark.type === 'underline') {
      current = { type: 'underline', children: [current] };
    } else if (mark.type === 'link') {
      current = {
        type: 'link',
        url: mark.attrs?.href ?? '',
        title: mark.attrs?.title ?? null,
        children: [current],
      };
    }
  }

  return current;
}

function getMathValue(node: JSONContent): string {
  let value: string;
  if (node.content && node.content.length > 0) {
    value = node.content.map((child) => child.text ?? '').join('');
  } else {
    value = String(node.attrs?.latex ?? node.attrs?.value ?? '');
  }
  // Strip any leftover normalizer placeholder tokens that may have leaked
  // into the text content (can happen with malformed math delimiters).
  return value.replace(/\uE000MDMATH_[a-z0-9]+_\d+\uE001/g, '');
}

function inlineToMarkdown(node: JSONContent): MarkdownNode[] {
  switch (node.type) {
    case 'text':
      return node.text ? [applyTextMarks(node.text, node.marks ?? [])] : [];
    case 'hardBreak':
      return [{ type: 'break' }];
    case 'image':
      return [
        {
          type: 'image',
          url: node.attrs?.src ?? '',
          alt: node.attrs?.alt ?? '',
          title: node.attrs?.title ?? null,
        },
      ];
    case 'inlineMath': {
      const mathValue = getMathValue(node);
      const openDelim = node.attrs?.openDelim;
      const closeDelim = node.attrs?.closeDelim;
      // Block math → $$...$$ (or \[...\]); inline math → $...$ (or \(...\))
      if (node.attrs?.display === 'yes') {
        return [{
          type: 'math',
          value: mathValue,
          openDelim,
          closeDelim,
          trailingBlankLines: Number(node.attrs.trailingBlankLines ?? 0),
        }];
      }
      return [{ type: 'inlineMath', value: mathValue, openDelim, closeDelim }];
    }
    case 'footnoteReference':
      return [
        {
          type: 'footnoteReference',
          identifier: node.attrs?.label ?? '',
          label: node.attrs?.label ?? '',
        },
      ];
    default:
      return [];
  }
}

function inlineChildrenToMarkdown(children: JSONContent[] = []): MarkdownNode[] {
  return children.flatMap((child) => inlineToMarkdown(child));
}

function flattenCell(children: JSONContent[] = []): MarkdownNode[] {
  const result: MarkdownNode[] = [];

  children.forEach((child, index) => {
    if (index > 0) {
      result.push({ type: 'break' });
    }

    if (child.type === 'paragraph') {
      result.push(...inlineChildrenToMarkdown(child.content));
      return;
    }

    result.push(...inlineToMarkdown(child));
  });

  return result.length > 0 ? result : [{ type: 'text', value: '' }];
}

function flowChildrenToMarkdown(children: JSONContent[] = []): MarkdownNode[] {
  return children.flatMap((child) => flowToMarkdown(child));
}

function flowToMarkdown(node: JSONContent): MarkdownNode[] {
  switch (node.type) {
    case 'inlineMath':
      return inlineToMarkdown(node);
    case 'paragraph': {
      // Promote display math out of paragraphs so `$$...$$` / `\[...\]` stay
      // block-level and round-trip without accumulating blank lines.
      const children = node.content ?? [];
      const blocks: MarkdownNode[] = [];
      let inlineBuffer: JSONContent[] = [];

      const flushInline = () => {
        if (inlineBuffer.length === 0) {
          return;
        }
        blocks.push({
          type: 'paragraph',
          children: inlineChildrenToMarkdown(inlineBuffer),
        });
        inlineBuffer = [];
      };

      for (const child of children) {
        if (child.type === 'inlineMath' && child.attrs?.display === 'yes') {
          flushInline();
          blocks.push(...inlineToMarkdown(child));
          continue;
        }
        inlineBuffer.push(child);
      }
      flushInline();

      return blocks.length > 0
        ? blocks
        : [{ type: 'paragraph', children: inlineChildrenToMarkdown([]) }];
    }
    case 'heading':
      return [
        {
          type: 'heading',
          depth: node.attrs?.level ?? 1,
          children: inlineChildrenToMarkdown(node.content),
        },
      ];
    case 'blockquote':
      return [{ type: 'blockquote', children: flowChildrenToMarkdown(node.content) }];
    case 'bulletList':
      return [
        {
          type: 'list',
          ordered: false,
          spread: false,
          children: (node.content ?? []).map((item) => ({
            type: 'listItem',
            spread: false,
            children: flowChildrenToMarkdown(item.content),
          })),
        },
      ];
    case 'orderedList':
      return [
        {
          type: 'list',
          ordered: true,
          start: node.attrs?.start ?? 1,
          spread: false,
          children: (node.content ?? []).map((item) => ({
            type: 'listItem',
            spread: false,
            children: flowChildrenToMarkdown(item.content),
          })),
        },
      ];
    case 'taskList':
      return [
        {
          type: 'list',
          ordered: false,
          spread: false,
          children: (node.content ?? []).map((item) => ({
            type: 'listItem',
            checked: Boolean(item.attrs?.checked),
            spread: false,
            children: flowChildrenToMarkdown(item.content),
          })),
        },
      ];
    case 'codeBlock':
      return [
        {
          type: 'code',
          lang: node.attrs?.language ?? null,
          value: node.content?.map((child) => child.text ?? '').join('') ?? '',
        },
      ];
    case 'inlineMath': {
      const mathValue = getMathValue(node);
      const openDelim = node.attrs?.openDelim;
      const closeDelim = node.attrs?.closeDelim;
      if (node.attrs?.display === 'yes') {
        return [{ type: 'math', value: mathValue, openDelim, closeDelim }];
      }
      return [{ type: 'inlineMath', value: mathValue, openDelim, closeDelim }];
    }
    case 'mermaidBlock':
      return [{ type: 'code', lang: 'mermaid', value: node.attrs?.code ?? '' }];
    case 'horizontalRule':
      return [{ type: 'thematicBreak' }];
    case 'image':
      return [{ type: 'paragraph', children: inlineToMarkdown(node) }];
    case 'table':
      return [
        {
          type: 'table',
          align: (node.content?.[0]?.content ?? []).map(() => null),
          children: (node.content ?? []).map((row) => ({
            type: 'tableRow',
            children: (row.content ?? []).map((cell) => ({
              type: 'tableCell',
              children: flattenCell(cell.content),
            })),
          })),
        },
      ];
    case 'footnoteDefinition':
      return [
        {
          type: 'footnoteDefinition',
          identifier: node.attrs?.label ?? '',
          label: node.attrs?.label ?? '',
          children: flowChildrenToMarkdown(node.content),
        },
      ];
    case 'htmlBlock':
      return [{ type: 'html', value: node.attrs?.html ?? '' }];
    default:
      return [];
  }
}

const UNDERLINE_DELIMITER_RE = /\+\+([^+]+)\+\+/g;

function splitUnderlineText(text: string, marks: NonNullable<JSONContent['marks']> = []): JSONContent[] {
  const parts: JSONContent[] = [];
  let lastIndex = 0;
  UNDERLINE_DELIMITER_RE.lastIndex = 0;

  for (const match of text.matchAll(UNDERLINE_DELIMITER_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push({ type: 'text', text: text.slice(lastIndex, index), marks });
    }

    const existingMarks = marks.filter((mark) => mark.type !== 'underline');
    parts.push({
      type: 'text',
      text: match[1] ?? '',
      marks: [...existingMarks, { type: 'underline' }],
    });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', text: text.slice(lastIndex), marks });
  }

  return parts;
}

function restoreUnderlineMarks(
  content: JSONContent[],
  parentRaw: boolean | null = null,
): JSONContent[] {
  const RAW_TEXT_NODES = new Set(['codeBlock', 'htmlBlock', 'inlineMath', 'mermaidBlock', 'image']);

  return content.flatMap((node): JSONContent[] => {
    if (!node || typeof node !== 'object') {
      return [node];
    }

    const raw = parentRaw === true || RAW_TEXT_NODES.has(node.type ?? '');

    if (node.type === 'text' && !raw) {
      const marks = node.marks ?? [];
      if (!marks.some((mark) => mark.type === 'code') && typeof node.text === 'string') {
        return splitUnderlineText(node.text, marks);
      }
      return [node];
    }

    if (Array.isArray(node.content)) {
      return [
        {
          ...node,
          content: restoreUnderlineMarks(node.content, raw),
        },
      ];
    }

  return [node];
  });
}

function checkedItemBlockSource(rawItem: string): string | null {
  const lines = rawItem.replace(/\r\n/g, '\n').split('\n');
  const first = lines[0] ?? '';
  const match = first.match(
    /^([ \t]*(?:>[ \t]?)*)(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]][ \t]+)?(.*)$/,
  );
  if (!match) return null;

  const quotePrefix = match[1] ?? '';
  const remainder = match[2] ?? '';
  const markerWidth = Math.max(first.length - quotePrefix.length - remainder.length, 0);
  const bodyLines = lines.map((line, index) => {
    if (index === 0) return remainder;
    let value = line;
    if (quotePrefix) {
      if (!value.startsWith(quotePrefix)) return '';
      value = value.slice(quotePrefix.length);
    }
    const indent = value.match(/^[ \t]*/)?.[0].length ?? 0;
    return value.slice(Math.min(indent, markerWidth));
  });
  return bodyLines.join('\n');
}

function checkedItemContainsBlock(source: string): boolean {
  const trimmed = source.trim();
  if (/^(?:`{3,}|~{3,})[\s\S]*(?:`{3,}|~{3,})$/.test(trimmed)) {
    return true;
  }

  const lines = trimmed.split('\n');
  return lines.length >= 2 && /\|/.test(lines[0] ?? '') &&
    /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[1] ?? '');
}

function removeLeadingTaskCheckboxFromParagraph(paragraph: MarkdownNode): MarkdownNode | null {
  let changed = false;
  const visit = (node: MarkdownNode): void => {
    if (!changed && typeof node.value === 'string') {
      const next = node.value.replace(/^\[[ xX]][ \t]*/, '');
      if (next !== node.value) {
        node.value = next;
        changed = true;
      }
      return;
    }
    if (!changed && Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  };

  visit(paragraph);
  if (!changed) return paragraph;
  return paragraph.value || Array.isArray(paragraph.children) ? paragraph : null;
}

function normalizeCheckedListItemBlocks(tree: MarkdownNode, source: string): void {
  const visit = (node: MarkdownNode): void => {
    if (Array.isArray(node.children)) {
      node.children.forEach((child: MarkdownNode) => visit(child));
    }

    if (node.type !== 'list') return;
    for (const item of node.children ?? []) {
      const position = item.position;
      const startOffset = position?.start?.offset;
      const endOffset = position?.end?.offset;
      if (
        item.checked === null || item.checked === undefined ||
        typeof startOffset !== 'number' || typeof endOffset !== 'number'
      ) continue;
      const itemLineStart = source.lastIndexOf('\n', Math.max(startOffset - 1, 0)) + 1;
      const rawItem = source.slice(itemLineStart, endOffset);
      const blockSource = checkedItemBlockSource(rawItem);
      if (!blockSource || !checkedItemContainsBlock(blockSource)) continue;

      const parsed = parser.parse(blockSource) as MarkdownNode;
      const blocks = parsed.children ?? [];
      if (blocks[0]?.type === 'paragraph') {
        const cleaned = removeLeadingTaskCheckboxFromParagraph(blocks[0]);
        if (!cleaned) blocks.shift();
      }
      if (blocks.length > 0) item.children = blocks;
    }
  };

  visit(tree);
}

export function parseMarkdown(markdown: string): JSONContent {
  const normalized = normalizeMathDelimiters(markdown);
  const tree = parser.parse(normalized.markdown) as MarkdownNode;
  normalizeCheckedListItemBlocks(tree, normalized.markdown);
  const context = collectDefinitions(tree);
  const content = flowChildrenToTiptap(tree.children ?? [], context, normalized.placeholders);
  const restoredContent = restoreLeakedMathTokens(content, normalized.placeholders);
  const underlinedContent = restoreUnderlineMarks(restoredContent);

  const doc = {
    type: 'doc',
    content: underlinedContent.length
      ? underlinedContent
      : [
          {
            type: 'paragraph',
          },
        ],
  };
  return migrateJSON(doc);
}

export function migrateJSON(node: any): any {
  if (!node) {
    return node;
  }

  if (node.type === 'mathInline') {
    return {
      type: 'inlineMath',
      attrs: {
        display: 'no',
        evaluate: 'no',
      },
      content: node.attrs?.value ? [{ type: 'text', text: String(node.attrs.value) }] : undefined,
    };
  }

  if (node.type === 'mathBlock') {
    return {
      type: 'inlineMath',
      attrs: {
        display: 'yes',
        evaluate: 'no',
      },
      content: node.attrs?.value ? [{ type: 'text', text: String(node.attrs.value) }] : undefined,
    };
  }

  if (node.type === 'inlineMath' && node.attrs?.latex !== undefined && !node.content) {
    const latexVal = String(node.attrs.latex);
    const nextAttrs = { ...node.attrs };
    delete nextAttrs.latex;
    return {
      ...node,
      attrs: nextAttrs,
      content: [{ type: 'text', text: latexVal }],
    };
  }

  if (node.content && Array.isArray(node.content)) {
    return {
      ...node,
      content: node.content.map(migrateJSON),
    };
  }

  return node;
}

export function parseMarkdownFragment(markdown: string): JSONContent[] {
  return parseMarkdown(markdown).content ?? [];
}

// ---- Custom AST-to-markdown stringifier (no escaping) ----

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[\\[\]]/g, '\\$&');
}

function escapeMarkdownLinkUrl(value: string): string {
  return value.replace(/[\\()]/g, '\\$&');
}

function stringifyInlineNodes(children: MarkdownNode[] = []): string {
  return children.map((child) => stringifyInlineNode(child)).join('');
}

function stringifyInlineNode(node: MarkdownNode): string {
  switch (node.type) {
    case 'text':
      return String(node.value ?? '');
    case 'strong':
      return `**${stringifyInlineNodes(node.children)}**`;
    case 'emphasis':
      return `*${stringifyInlineNodes(node.children)}*`;
    case 'inlineCode':
      return `\`${String(node.value ?? '')}\``;
    case 'delete':
      return `~~${stringifyInlineNodes(node.children)}~~`;
    case 'underline':
      return `++${stringifyInlineNodes(node.children)}++`;
    case 'link':
      return `[${escapeMarkdownLinkText(stringifyInlineNodes(node.children))}](${escapeMarkdownLinkUrl(String(node.url ?? ''))}${node.title ? ` "${node.title}"` : ''})`;
    case 'image':
      return `![${String(node.alt ?? '')}](${String(node.url ?? '')}${node.title ? ` "${node.title}"` : ''})`;
    case 'break':
      return '\n';
    case 'inlineMath': {
      const val = String(node.value ?? '');
      const open = (node as any).openDelim || '$';
      const close = (node as any).closeDelim || '$';
      return `${open}${val}${close}`;
    }
    case 'math': {
      const val = String(node.value ?? '');
      const open = (node as any).openDelim || '$$';
      const close = (node as any).closeDelim || '$$';
      const delimLen = Math.max(open.length, close.length);
      // For multi-char delimiters like \[ \], put content on its own lines
      if (delimLen > 1) {
        return `${open}\n${val}\n${close}`;
      }
      return `${open}${val}${close}`;
    }
    case 'footnoteReference':
      return `[^${String(node.label ?? node.identifier ?? '')}]`;
    case 'html':
      return String(node.value ?? '');
    default:
      return '';
  }
}

function stringifyBlockNodes(children: MarkdownNode[] = []): string {
  return children.map((child) => stringifyBlockNode(child)).reduce(
    (result, block, index) => {
      if (index === 0) return block;
      const previous = children[index - 1];
      const blankLines = previous?.type === 'math'
        ? Math.max(Number(previous.trailingBlankLines ?? 0), 0)
        : 0;
      return `${result}${'\n'.repeat(2 + blankLines)}${block}`;
    },
    '',
  );
}

/** List item children stay tight (single newlines) to preserve nested list shape. */
function stringifyListItemChildren(children: MarkdownNode[] = []): string {
  return children.map((child) => stringifyBlockNode(child)).join('\n');
}

function stringifyBlockNode(node: MarkdownNode): string {
  switch (node.type) {
    case 'paragraph':
      return stringifyInlineNodes(node.children);
    case 'heading':
      return `${'#'.repeat(node.depth ?? 1)} ${stringifyInlineNodes(node.children)}`;
    case 'blockquote': {
      const inner = stringifyBlockNodes(node.children);
      return inner
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    }
    case 'code':
      {
        const value = String(node.value ?? '');
        const runs = value.match(/`+/g) ?? [];
        const fenceLength = Math.max(3, ...runs.map((run) => run.length)) + 1;
        const fence = '`'.repeat(fenceLength);
        return `${fence}${node.lang ?? ''}\n${value}\n${fence}`;
      }
    case 'math': {
      const val = String(node.value ?? '');
      const open = String((node as any).openDelim || '$$');
      const close = String((node as any).closeDelim || '$$');
      // Multi-char delimiters ($$, \[ \]) put content on its own lines.
      if (Math.max(open.length, close.length) > 1) {
        return `${open}\n${val}\n${close}`;
      }
      return `${open}${val}${close}`;
    }
    case 'list': {
      const ordered = Boolean(node.ordered);
      const start = node.start ?? 1;
      return (node.children ?? [])
        .map((item: MarkdownNode, index: number) => {
          const checked = item.checked;
          let marker: string;
          if (checked === true) {
            marker = '- [x] ';
          } else if (checked === false) {
            marker = '- [ ] ';
          } else if (ordered) {
            marker = `${start + index}. `;
          } else {
            marker = '- ';
          }

          // Tight lists: join child blocks with single newlines so nested lists
          // don't pick up an extra blank line between the parent item and children.
          const itemContent = stringifyListItemChildren(item.children);
          const lines = itemContent.split('\n');
          const firstLine = `${marker}${lines[0] ?? ''}`;
          const restLines = lines.slice(1).map((line) => (line ? `  ${line}` : ''));
          return [firstLine, ...restLines].join('\n');
        })
        .join('\n');
    }
    case 'listItem': {
      const checked = node.checked;
      const marker = checked === true ? '- [x] ' : checked === false ? '- [ ] ' : '- ';
      const inner = stringifyListItemChildren(node.children);
      const lines = inner.split('\n');
      const firstLine = `${marker}${lines[0] ?? ''}`;
      const restLines = lines.slice(1).map((line) => (line ? `  ${line}` : ''));
      return [firstLine, ...restLines].join('\n');
    }
    case 'table': {
      const rows = (node.children ?? []).map((row: MarkdownNode) =>
        (row.children ?? []).map((cell: MarkdownNode) =>
          stringifyInlineNodes(cell.children).replace(/\|/g, '\\|').replace(/\n/g, ' '),
        ),
      );
      if (rows.length === 0) return '';
      const colCount = Math.max(...rows.map((r: string[]) => r.length));
      const padRow = (r: string[]) =>
        Array.from({ length: colCount }, (_, i) => r[i] ?? '');
      const header = padRow(rows[0]!);
      const sep = Array.from({ length: colCount }, () => '---');
      const body = rows.slice(1).map(padRow);
      return [
        `| ${header.join(' | ')} |`,
        `| ${sep.join(' | ')} |`,
        ...body.map((r: string[]) => `| ${r.join(' | ')} |`),
      ].join('\n');
    }
    case 'tableRow':
      return (node.children ?? []).map((cell: MarkdownNode) =>
        stringifyInlineNodes(cell.children),
      ).join(' | ');
    case 'tableCell':
      return stringifyInlineNodes(node.children);
    case 'thematicBreak':
      return '---';
    case 'html':
      return String(node.value ?? '');
    case 'footnoteDefinition':
      return `[^${String(node.label ?? node.identifier ?? '')}]: ${stringifyBlockNodes(node.children)}`;
    case 'definition':
      return `[${String(node.identifier ?? '')}]: ${String(node.url ?? '')}${node.title ? ` "${node.title}"` : ''}`;
    default:
      return '';
  }
}

function getLastNonEmptyBlock(children: MarkdownNode[]): { index: number; node: MarkdownNode } | null {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const node = children[index];
    if (!node) {
      continue;
    }
    if (stringifyBlockNode(node) !== '') {
      return { index, node };
    }
  }
  return null;
}

export function serializeMarkdown(document: JSONContent): string {
  const children = flowChildrenToMarkdown(document.content);
  const markdown = stringifyBlockNodes(children);
  const lastBlock = getLastNonEmptyBlock(children);
  if (lastBlock && lastBlock.node.type === 'math' && lastBlock.index < children.length - 1) {
    // A display formula inserted through the visual editor keeps an empty
    // paragraph after it. Preserve that blank line in source so the user's next
    // input starts on a separate paragraph instead of touching the closing
    // delimiter.
    return `${markdown.replace(/\s+$/, '')}\n\n`;
  }
  return markdown.trimEnd().length === 0 ? '' : `${markdown.trimEnd()}\n`;
}

export function serializeMarkdownFragment(content: JSONContent[] = []): string {
  return serializeMarkdown({
    type: 'doc',
    content,
  });
}
