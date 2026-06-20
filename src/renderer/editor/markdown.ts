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

  const createMathToken = (kind: 'inline' | 'block', value: string): string => {
    const token = `@@MARKDOWN_EDITOR_MATH_${mathPlaceholders.size}@@`;
    mathPlaceholders.set(token, { kind, value });
    return kind === 'block' ? `\n${token}\n` : token;
  };

  let normalized = markdown;
  normalized = protect(/```[\s\S]*?```/g, normalized);
  normalized = protect(/~~~[\s\S]*?~~~/g, normalized);
  normalized = protect(/`[^`\n]+`/g, normalized);
  normalized = normalizeBlockMathPairs(normalized, '\\[', '\\]', createMathToken);
  normalized = normalizeBlockMathPairs(normalized, '$$', '$$', createMathToken);
  normalized = normalizeInlineMathPairs(normalized, '\\(', '\\)', createMathToken);
  normalized = normalizeInlineMathPairs(normalized, '$', '$', createMathToken);

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
  createMathToken: (kind: 'inline' | 'block', value: string) => string,
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
    result += createMathToken('block', expression);
    cursor = closeIndex + close.length;
  }

  return result;
}

function normalizeInlineMathPairs(
  markdown: string,
  open: string,
  close: string,
  createMathToken: (kind: 'inline' | 'block', value: string) => string,
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

    const searchStart = cursor + open.length;
    const closeIndex = findInlineMathClose(markdown, searchStart, close);
    if (closeIndex === -1) {
      result += markdown[cursor];
      cursor += 1;
      continue;
    }

    const expression = markdown.slice(searchStart, closeIndex).trim();
    if (!expression) {
      result += markdown[cursor];
      cursor += 1;
      continue;
    }

    result += createMathToken('inline', expression);
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
    if (placeholder?.kind === 'inline') {
      parts.push({
        type: 'mathInline',
        attrs: {
          value: placeholder.value,
        },
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

function getBlockMathPlaceholder(node: MarkdownNode, placeholders: Map<string, MathPlaceholder>): string | null {
  if (node.type !== 'paragraph') {
    return null;
  }

  const children = node.children ?? [];
  if (children.length !== 1 || children[0]?.type !== 'text') {
    return null;
  }

  const token = String(children[0].value ?? '').trim();
  const placeholder = placeholders.get(token);
  return placeholder?.kind === 'block' ? placeholder.value : null;
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
          type: 'mathInline',
          attrs: {
            value: String(node.value ?? ''),
          },
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
      const blockMathValue = getBlockMathPlaceholder(node, mathPlaceholders);
      if (blockMathValue !== null) {
        return [
          {
            type: 'mathBlock',
            attrs: {
              value: blockMathValue,
            },
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
          type: 'mathBlock',
          attrs: {
            value: String(node.value ?? ''),
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
    case 'mathInline':
      return [{ type: 'inlineMath', value: node.attrs?.value ?? '' }];
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
    case 'paragraph':
      return [{ type: 'paragraph', children: inlineChildrenToMarkdown(node.content) }];
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
    case 'mathBlock':
      return [{ type: 'math', value: node.attrs?.value ?? '' }];
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

  return {
    type: 'doc',
    content: content.length
      ? content
      : [
          {
            type: 'paragraph',
          },
        ],
  };
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
    case 'inlineMath':
      return `$${String(node.value ?? '')}$`;
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
    case 'math':
      return `$$\n${String(node.value ?? '')}\n$$`;
    case 'list': {
      const ordered = Boolean(node.ordered);
      const start = node.start ?? 1;
      return (node.children ?? []).map((item: MarkdownNode, index: number) => {
        const marker = ordered ? `${start + index}. ` : '- ';
        const itemContent = stringifyBlockNodes(item.children);
        const lines = itemContent.split('\n');
        const firstLine = `${marker}${lines[0] ?? ''}`;
        const restLines = lines.slice(1).map((line) => (line ? `  ${line}` : ''));
        return [firstLine, ...restLines].join('\n');
      }).join('\n');
    }
    case 'listItem': {
      const checked = node.checked;
      const marker = checked === true ? '[x]' : checked === false ? '[ ]' : null;
      const inner = stringifyBlockNodes(node.children);
      const prefix = marker ? `- ${marker} ` : '- ';
      const lines = inner.split('\n');
      const firstLine = `${prefix}${lines[0] ?? ''}`;
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
