function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ');
}

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
]);

function trimMarkdownBlock(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function parseInlineStyle(element: HTMLElement): Map<string, string> {
  const style = new Map<string, string>();
  const raw = element.getAttribute('style') ?? '';

  raw.split(';').forEach((entry) => {
    const [property, ...valueParts] = entry.split(':');
    if (!property || valueParts.length === 0) {
      return;
    }

    style.set(property.trim().toLowerCase(), valueParts.join(':').trim().toLowerCase());
  });

  return style;
}

function getClassName(element: HTMLElement): string {
  return (element.getAttribute('class') ?? '').toLowerCase();
}

function parseCssSizeToPx(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const match = value.match(/^(-?\d+(?:\.\d+)?)(px|pt|rem|em)?$/i);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? 'px').toLowerCase();

  if (Number.isNaN(amount)) {
    return null;
  }

  switch (unit) {
    case 'px':
      return amount;
    case 'pt':
      return amount * (96 / 72);
    case 'rem':
    case 'em':
      return amount * 16;
    default:
      return amount;
  }
}

function getNumericFontWeight(element: HTMLElement): number | null {
  const style = parseInlineStyle(element);
  const value = style.get('font-weight') ?? '';
  const className = getClassName(element);

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  if (value === 'bold') {
    return 700;
  }

  if (value === 'bolder') {
    return 800;
  }

  if (/(^|\s)(font-bold|fw-bold|semibold|font-semibold)(\s|$)/.test(className)) {
    return 700;
  }

  if (/(^|\s)(font-medium|fw-medium)(\s|$)/.test(className)) {
    return 500;
  }

  return null;
}

function getFontSizePx(element: HTMLElement): number | null {
  const style = parseInlineStyle(element);
  const inlineSize = parseCssSizeToPx(style.get('font-size') ?? null);
  if (inlineSize !== null) {
    return inlineSize;
  }

  const className = getClassName(element);
  const textSizeMap: Array<[RegExp, number]> = [
    [/(^|\s)text-(xs)(\s|$)/, 12],
    [/(^|\s)text-(sm)(\s|$)/, 14],
    [/(^|\s)text-(base)(\s|$)/, 16],
    [/(^|\s)text-(lg)(\s|$)/, 18],
    [/(^|\s)text-(xl)(\s|$)/, 20],
    [/(^|\s)text-2xl(\s|$)/, 24],
    [/(^|\s)text-3xl(\s|$)/, 30],
    [/(^|\s)text-4xl(\s|$)/, 36],
    [/(^|\s)text-5xl(\s|$)/, 48],
  ];

  for (const [pattern, size] of textSizeMap) {
    if (pattern.test(className)) {
      return size;
    }
  }

  return null;
}

function isVisuallyBold(element: HTMLElement): boolean {
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'strong' || tagName === 'b') {
    return true;
  }

  const weight = getNumericFontWeight(element);
  if (weight !== null && weight >= 600) {
    return true;
  }

  return /(^|\s)(font-bold|fw-bold|semibold|font-semibold)(\s|$)/.test(getClassName(element));
}

function isVisuallyItalic(element: HTMLElement): boolean {
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'em' || tagName === 'i') {
    return true;
  }

  const style = parseInlineStyle(element);
  if (style.get('font-style') === 'italic') {
    return true;
  }

  return /(^|\s)(italic)(\s|$)/.test(getClassName(element));
}

function isVisuallyStruck(element: HTMLElement): boolean {
  const tagName = element.tagName.toLowerCase();
  if (tagName === 's' || tagName === 'del') {
    return true;
  }

  const style = parseInlineStyle(element);
  const textDecoration = style.get('text-decoration') ?? style.get('text-decoration-line') ?? '';
  if (textDecoration.includes('line-through')) {
    return true;
  }

  return /(^|\s)(line-through)(\s|$)/.test(getClassName(element));
}

function getHeadingLevelFromPresentation(element: HTMLElement): number | null {
  const ariaLevel = Number(element.getAttribute('aria-level') ?? '');
  if (element.getAttribute('role') === 'heading' && Number.isFinite(ariaLevel) && ariaLevel >= 1 && ariaLevel <= 6) {
    return ariaLevel;
  }

  const className = getClassName(element);
  const classLevelMatch = className.match(/(^|\s)h([1-6])(\s|$)/);
  if (classLevelMatch) {
    return Number(classLevelMatch[2]);
  }

  const fontSize = getFontSizePx(element);
  const fontWeight = getNumericFontWeight(element) ?? 400;
  const text = normalizeText(element.textContent ?? '').trim();
  if (!text) {
    return null;
  }

  if (fontWeight < 600 || fontSize === null) {
    return null;
  }

  if (fontSize >= 30) {
    return 1;
  }

  if (fontSize >= 24) {
    return 2;
  }

  if (fontSize >= 20) {
    return 3;
  }

  if (fontSize >= 18) {
    return 4;
  }

  return null;
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ').trim();
}

function extractCodeLanguage(element: Element): string {
  const className = element.getAttribute('class') ?? '';
  const match = className.match(/(?:language-|lang-)([\w-]+)/i);
  return match?.[1] ?? '';
}

function extractMathSource(element: Element): { value: string; display: boolean } | null {
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  const datasetValue =
    element.getAttribute('data-tex') ??
    element.getAttribute('data-math') ??
    element.getAttribute('tex');

  if (datasetValue?.trim()) {
    const className = getClassName(element);
    const display =
      element.classList.contains('katex-display') ||
      Boolean(element.closest('.katex-display')) ||
      Boolean(element.querySelector('.MathJax_SVG_Display')) ||
      /(^|\s)(math-display|ztext-math--display)(\s|$)/.test(className);

    return {
      value: datasetValue.trim(),
      display,
    };
  }

  const annotation = element.querySelector('annotation[encoding="application/x-tex"]');
  if (!annotation?.textContent?.trim()) {
    return null;
  }

  const display =
    element.classList.contains('katex-display') ||
    Boolean(element.closest('.katex-display'));

  return {
    value: annotation.textContent.trim(),
    display,
  };
}

function extractStandaloneDisplayMath(element: HTMLElement): string | null {
  const ownMath = extractMathSource(element);
  if (ownMath?.display) {
    return ownMath.value;
  }

  const meaningfulChildren = Array.from(element.childNodes).filter((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      return Boolean((child.textContent ?? '').trim());
    }

    return child instanceof HTMLElement;
  });

  if (meaningfulChildren.length !== 1) {
    return null;
  }

  const onlyChild = meaningfulChildren[0];
  if (!(onlyChild instanceof HTMLElement)) {
    return null;
  }

  const childMath = extractMathSource(onlyChild);
  return childMath?.display ? childMath.value : null;
}

interface InlineFormatContext {
  bold: boolean;
  italic: boolean;
  struck: boolean;
}

const DEFAULT_INLINE_FORMAT_CONTEXT: InlineFormatContext = {
  bold: false,
  italic: false,
  struck: false,
};

function renderInlineChildren(node: Node, context: InlineFormatContext = DEFAULT_INLINE_FORMAT_CONTEXT): string {
  return Array.from(node.childNodes)
    .map((child) => renderInlineNode(child, context))
    .join('');
}

function renderInlineNode(node: Node, context: InlineFormatContext = DEFAULT_INLINE_FORMAT_CONTEXT): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeText(node.textContent ?? '');
  }

  if (!(node instanceof HTMLElement)) {
    return '';
  }

  const tagName = node.tagName.toLowerCase();
  if (tagName === 'script' || tagName === 'style') {
    return '';
  }

  const math = extractMathSource(node);
  if (math && !math.display) {
    return `$${math.value}$`;
  }

  switch (tagName) {
    case 'table':
    case 'tr':
    case 'td':
    case 'th': {
      // GFM cells are inline-only. Flatten a nested layout into one line while
      // keeping token boundaries so nested tables do not duplicate or merge text.
      const content = renderInlineChildren(node, context).replace(/\s+/g, ' ').trim();
      return ` ${content} `;
    }
    case 'code':
      if (node.closest('pre')) {
        return node.textContent ?? '';
      }
      return `\`${(node.textContent ?? '').replace(/`/g, '\\`')}\``;
    case 'a': {
      const label = renderInlineChildren(node, context).trim() || (node.textContent ?? '').trim();
      const href = node.getAttribute('href') ?? '';
      return href ? `[${label}](${href})` : label;
    }
    case 'img': {
      const alt = node.getAttribute('alt') ?? '';
      const src = node.getAttribute('src') ?? '';
      return src ? `![${alt}](${src})` : '';
    }
    case 'br':
      return '\n';
    case 'span':
    case 'sub':
    case 'sup':
    default: {
      const nextContext: InlineFormatContext = {
        bold: context.bold || isVisuallyBold(node),
        italic: context.italic || isVisuallyItalic(node),
        struck: context.struck || isVisuallyStruck(node),
      };
      const content = renderInlineChildren(node, nextContext);
      const trimmed = content.trim();

      if (!trimmed) {
        return content;
      }

      let result = content;
      if (nextContext.bold && !context.bold) {
        result = `**${result.trim()}**`;
      }
      if (nextContext.italic && !context.italic) {
        result = `*${result.trim()}*`;
      }
      if (nextContext.struck && !context.struck) {
        result = `~~${result.trim()}~~`;
      }

      return result;
    }
  }
}

function renderListItem(element: HTMLElement, ordered: boolean, index: number, start = 1): string {
  const checkbox = element.querySelector(':scope > input[type="checkbox"]');
  const checked = checkbox?.hasAttribute('checked') || (checkbox as HTMLInputElement)?.checked;
  const prefix = checkbox
    ? `- [${checked ? 'x' : ' '}] `
    : ordered
      ? `${index + start}. `
      : '- ';
  const nestedBlocks: string[] = [];
  const inlineParts: string[] = [];

  Array.from(element.childNodes).forEach((child) => {
    if (child instanceof HTMLElement && ['ul', 'ol'].includes(child.tagName.toLowerCase())) {
      const nested = renderBlockNode(child);
      if (nested) {
        nestedBlocks.push(nested);
      }
      return;
    }

    if (child instanceof HTMLElement && ['p', 'div'].includes(child.tagName.toLowerCase())) {
      if (hasDirectBlockChildren(child)) {
        const nested = renderBlockNode(child);
        if (nested) nestedBlocks.push(nested);
        return;
      }
      const value = renderInlineChildren(child).trim();
      if (value) {
        inlineParts.push(value);
      }
      return;
    }

    if (child === checkbox) {
      return;
    }

    if (child instanceof HTMLElement && BLOCK_TAGS.has(child.tagName.toLowerCase())) {
      const nested = renderBlockNode(child);
      if (nested) {
        nestedBlocks.push(nested);
      }
      return;
    }

    const inline = renderInlineNode(child).trim();
    if (inline) {
      inlineParts.push(inline);
    }
  });

  const firstLine = `${prefix}${inlineParts.join(' ').trim()}`.trimEnd();
  const nested = nestedBlocks
    .map((block) => block.split('\n').map((line) => (line ? `  ${line}` : line)).join('\n'))
    .join('\n');

  return trimMarkdownBlock([firstLine, nested].filter(Boolean).join('\n'));
}

function renderTable(element: HTMLElement): string {
  const caption = element.querySelector(':scope > caption');
  const captionMarkdown = caption ? renderInlineChildren(caption).trim() : '';
  const rows = Array.from(
    element.querySelectorAll(':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr'),
  ).map((row) => {
    return Array.from(row.children).map((cell) => escapeTableCell(renderInlineNode(cell).trim()));
  });

  if (rows.length === 0) {
    return '';
  }

  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizeRow = (row: string[]) =>
    Array.from({ length: columnCount }, (_, index) => row[index] ?? '');

  const header = normalizeRow(rows[0]);
  const separator = Array.from({ length: columnCount }, () => '---');
  const body = rows.slice(1).map(normalizeRow);
  const table = [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');

  return trimMarkdownBlock(
    captionMarkdown ? `${captionMarkdown}\n\n${table}` : table,
  );
}

function hasDirectBlockChildren(element: HTMLElement): boolean {
  return Array.from(element.childNodes).some((child) => {
    return child instanceof HTMLElement && BLOCK_TAGS.has(child.tagName.toLowerCase());
  });
}

function renderBlockNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeText(node.textContent ?? '').trim();
  }

  if (!(node instanceof HTMLElement)) {
    return '';
  }

  const tagName = node.tagName.toLowerCase();
  if (['script', 'style'].includes(tagName)) {
    return '';
  }

  const standaloneDisplayMath = extractStandaloneDisplayMath(node);
  if (standaloneDisplayMath) {
    return `$$\n${standaloneDisplayMath}\n$$`;
  }

  switch (tagName) {
    case 'details': {
      const summary = node.querySelector(':scope > summary');
      const summaryText = summary ? renderInlineChildren(summary).trim() : '';
      const body = node.cloneNode(true) as HTMLElement;
      body.querySelector(':scope > summary')?.remove();
      return trimMarkdownBlock([
        ...(summaryText ? [`**${summaryText}**`] : []),
        renderChildren(body),
      ].filter(Boolean).join('\n\n'));
    }
    case 'summary':
      return renderInlineChildren(node).trim();
    case 'dl': {
      return trimMarkdownBlock(Array.from(node.children)
        .map((child) => {
          if (!(child instanceof HTMLElement)) return '';
          const text = renderInlineChildren(child).trim();
          return child.tagName.toLowerCase() === 'dt' && text ? `**${text}**` : text;
        })
        .filter(Boolean)
        .join('\n\n'));
    }
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number(tagName[1]);
      return `${'#'.repeat(level)} ${renderInlineChildren(node).trim()}`;
    }
    case 'p': {
      const level = getHeadingLevelFromPresentation(node);
      if (level !== null) {
        return `${'#'.repeat(level)} ${renderInlineChildren(node).trim()}`;
      }
      return renderInlineChildren(node).trim();
    }
    case 'div':
    case 'section':
    case 'article':
    case 'main':
    case 'header':
    case 'footer':
    case 'aside':
    case 'nav':
    case 'figure':
    case 'figcaption': {
      const level = getHeadingLevelFromPresentation(node);
      if (level !== null && !hasDirectBlockChildren(node)) {
        return `${'#'.repeat(level)} ${renderInlineChildren(node).trim()}`;
      }
      return hasDirectBlockChildren(node)
        ? renderChildren(node)
        : renderInlineChildren(node).trim();
    }
    case 'blockquote': {
      const content = renderChildren(node);
      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => `> ${line}`)
        .join('\n');
    }
    case 'ul':
      return Array.from(node.children)
        .filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName.toLowerCase() === 'li')
        .map((child, index) => renderListItem(child, false, index))
        .join('\n');
    case 'ol':
    {
      const start = Math.max(Number(node.getAttribute('start') ?? '1') || 1, 1);
      return Array.from(node.children)
        .filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName.toLowerCase() === 'li')
        .map((child, index) => renderListItem(child, true, index, start))
        .join('\n');
    }
    case 'pre': {
      const code = node.querySelector('code');
      const language = code ? extractCodeLanguage(code) : '';
      const value = (code?.textContent ?? node.textContent ?? '').replace(/\n$/, '');
      return `\`\`\`${language}\n${value}\n\`\`\``;
    }
    case 'table':
      return renderTable(node);
    case 'hr':
      return '---';
    case 'img':
      return renderInlineNode(node);
    default:
      return renderInlineChildren(node).trim();
  }
}

function renderChildren(root: ParentNode): string {
  return Array.from(root.childNodes)
    .map((child) => renderBlockNode(child))
    .filter(Boolean)
    .join('\n\n');
}

export function looksLikeStructuredHtml(html: string): boolean {
  const trimmed = html.trim();
  if (!trimmed) {
    return false;
  }

  return /<(h[1-6]|p|div|blockquote|ul|ol|li|pre|code|strong|b|em|i|table|tr|td|th|a|img|hr|math|annotation)\b/i.test(
    trimmed,
  );
}

export function convertHtmlToMarkdown(html: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const markdown = renderChildren(document.body);
  return trimMarkdownBlock(markdown);
}
