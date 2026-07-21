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
}

function normalizeMathDelimiters(markdown: string): {
  markdown: string;
  placeholders: Map<string, MathPlaceholder>;
} {
  const placeholders: string[] = [];
  const mathPlaceholders = new Map<string, MathPlaceholder>();

  const protect = (pattern: RegExp, input: string): string =>
    input.replace(pattern, (match) => {
      const token = `@@MARKDOWN_EDITOR_TOKEN_${placeholders.length}@@`;
      placeholders.push(match);
      return token;
    });

  const createMathToken = (kind: 'inline' | 'block', value: string, openDelim: string, closeDelim: string): string => {
    const token = `@@MARKDOWN_EDITOR_MATH_${mathPlaceholders.size}@@`;
    mathPlaceholders.set(token, { kind, value, openDelim, closeDelim });
    return kind === 'block' ? `\n${token}\n` : token;
  };

  let normalized = markdown;
  normalized = protect(/```[\s\S]*?```/g, normalized);
  normalized = protect(/~~~[\s\S]*?~~~/g, normalized);
  normalized = protect(/`[^`\n]+`/g, normalized);
  normalized = normalizeBlockMathPairs(normalized, '\\[', '\\]', createMathToken, '\\[', '\\]');
  normalized = normalizeBlockMathPairs(normalized, '$$', '$$', createMathToken, '$$', '$$');
  normalized = normalizeInlineMathPairs(normalized, '\\(', '\\)', createMathToken, '\\(', '\\)');
  normalized = normalizeInlineMathPairs(normalized, '$', '$', createMathToken, '$', '$');

  return {
    markdown: normalized.replace(/@@MARKDOWN_EDITOR_TOKEN_(\d+)@@/g, (_match, index) => {
      return placeholders[Number(index)] ?? '';
    }),
    placeholders: mathPlaceholders,
  };
}

function normalizeBlockMathPairs(
  markdown: string,
  open: string,
  close: string,
  createMathToken: (kind: 'inline' | 'block', value: string, openDelim: string, closeDelim: string) => string,
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

    const closeIndex = markdown.indexOf(close, cursor + open.length);
    if (closeIndex === -1) {
      result += markdown[cursor];
      cursor += 1;
      continue;
    }

    const expression = markdown.slice(cursor + open.length, closeIndex).trim();
    result += createMathToken('block', expression, openDelim, closeDelim);
    cursor = closeIndex + close.length;
  }

  return result;
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
  createMathToken: (kind: 'inline' | 'block', value: string, openDelim: string, closeDelim: string) => string,
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

    result += createMathToken('inline', expression, openDelim, closeDelim);
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

function splitTextWithMathPlaceholders(
  text: string,
  placeholders: Map<string, MathPlaceholder>,
): JSONContent[] {
  const tokenPattern = /@@MARKDOWN_EDITOR_MATH_\d+@@/g;
  const parts: JSONContent[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push({
        type: 'text',
        text: text.slice(lastIndex, start),
      });
    }

    const placeholder = placeholders.get(token);
    if (placeholder) {
      // Both inline and block placeholders become inlineMath nodes. Block math
      // uses display="yes". Never leave raw @@MARKDOWN_EDITOR_MATH_*@@ tokens
      // in the document — that was a major mode-switch corruption source.
      parts.push({
        type: 'inlineMath',
        attrs: {
          display: placeholder.kind === 'block' ? 'yes' : 'no',
          openDelim: placeholder.openDelim,
          closeDelim: placeholder.closeDelim,
        },
        content: placeholder.value ? [{ type: 'text', text: placeholder.value }] : undefined,
      });
    } else {
      parts.push({
        type: 'text',
        text: token,
      });
    }

    lastIndex = start + token.length;
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
  const match = text.match(/@@MARKDOWN_EDITOR_MATH_\d+@@/);
  if (!match) {
    return null;
  }

  const token = match[0];
  const placeholder = placeholders.get(token);
  return placeholder?.kind === 'block' ? placeholder : null;
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
            },
            content: blockMathPH.value ? [{ type: 'text', text: blockMathPH.value }] : undefined,
          },
        ];
      }

      const content = inlineChildrenToTiptap(node.children ?? [], context, mathPlaceholders);

      if (content.length === 1 && content[0].type === 'image') {
        return content;
      }

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
      const isTaskList = (node.children ?? []).some(
        (child: MarkdownNode) => child.checked !== null && child.checked !== undefined,
      );

      return [
        {
          type: isTaskList ? 'taskList' : node.ordered ? 'orderedList' : 'bulletList',
          attrs: node.ordered ? { start: node.start ?? 1 } : undefined,
          content: (node.children ?? []).map((child: MarkdownNode) => ({
            type: isTaskList ? 'taskItem' : 'listItem',
            attrs: isTaskList ? { checked: Boolean(child.checked) } : undefined,
            content: flowChildrenToTiptap(child.children ?? [], context, mathPlaceholders),
          })),
        },
      ];
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
  return value.replace(/@@MARKDOWN_EDITOR_MATH_\d+@@/g, '');
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
        return [{ type: 'math', value: mathValue, openDelim, closeDelim }];
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

export function parseMarkdown(markdown: string): JSONContent {
  const normalized = normalizeMathDelimiters(markdown);
  const tree = parser.parse(normalized.markdown) as MarkdownNode;
  const context = collectDefinitions(tree);
  const content = flowChildrenToTiptap(tree.children ?? [], context, normalized.placeholders);

  const doc = {
    type: 'doc',
    content: content.length
      ? content
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
  return children.map((child) => stringifyBlockNode(child)).join('\n\n');
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
      return `\`\`\`${node.lang ?? ''}\n${String(node.value ?? '')}\n\`\`\``;
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

export function serializeMarkdown(document: JSONContent): string {
  const children = flowChildrenToMarkdown(document.content);
  const markdown = stringifyBlockNodes(children).trimEnd();
  return markdown.length === 0 ? '' : `${markdown}\n`;
}

export function serializeMarkdownFragment(content: JSONContent[] = []): string {
  return serializeMarkdown({
    type: 'doc',
    content,
  });
}
