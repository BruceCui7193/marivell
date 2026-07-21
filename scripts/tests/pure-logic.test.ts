/**
 * Automated tests against SHIPPED pure-logic entry points.
 * Run: npx tsx scripts/tests/pure-logic.test.ts
 */
import { parseMarkdown, serializeMarkdown, serializeMarkdownFragment } from '../../src/renderer/editor/markdown.ts';
import { highlightMarkdownSource, offsetToLineCol } from '../../src/renderer/editor/markdown-highlight.ts';
import {
  findSourceSearchMatches,
  replaceSourceSearchMatch,
  replaceAllSourceSearchMatches,
} from '../../src/renderer/editor/search.ts';
import {
  hasExclusiveMarkdownStructure,
  looksLikeMarkdown,
} from '../../src/renderer/editor/plugins/markdown-paste.ts';
import { calculateDocumentStats } from '../../src/renderer/editor/utils/helpers.ts';
import { extractOutline } from '../../src/renderer/utils/document.ts';
import { markdownToExportHtmlFragment } from '../../src/main/export/markdown-to-html.ts';
import {
  serializeSliceForClipboard,
  tableMatrixToHtml,
  tableMatrixToMarkdown,
  tableMatrixToTsv,
} from '../../src/renderer/editor/clipboard.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  const msg = `  ✗ ${name}${detail ? ` — ${detail}` : ''}`;
  failures.push(msg);
  console.error(msg);
}

function assertEqual(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title: string): void {
  console.log(`\n## ${title}`);
}

// ---------------------------------------------------------------------------
// Markdown parse ↔ serialize
// ---------------------------------------------------------------------------
section('markdown parse/serialize');

{
  const samples = [
    '# Hello\n\nParagraph with $E=mc^2$ math.\n',
    'Price is $5 and $10 only\n',
    'Task list:\n\n- [ ] todo\n- [x] done\n',
    'Nested:\n\n- a\n  - b\n  - c\n- d\n',
    '| A | B |\n| --- | --- |\n| 1 | 2 |\n',
    '```js\nconsole.log(1)\n```\n',
    String.raw`Inline: \(x^2\)` + '\n',
    String.raw`Block:

\[
a+b
\]
`,
    '$$\na+b\n$$\n',
    '> quote line\n',
    '1. first\n2. second\n',
    '![alt](./x.png)\n',
    'Text[^1]\n\n[^1]: footnote body\n',
    '~~strike~~ and **bold** and *em*\n',
  ];

  for (const sample of samples) {
    const once = serializeMarkdown(parseMarkdown(sample));
    const twice = serializeMarkdown(parseMarkdown(once));
    assert(
      `stable: ${JSON.stringify(sample).slice(0, 48)}`,
      once === twice,
      `once=${JSON.stringify(once)} twice=${JSON.stringify(twice)}`,
    );
    assert(
      `no phantom tokens: ${JSON.stringify(sample).slice(0, 32)}`,
      !once.includes('MARKDOWN_EDITOR') && !once.includes('MDEDITORSELECTION'),
    );
  }

  const taskOut = serializeMarkdown(parseMarkdown('- [ ] open\n- [x] closed\n'));
  assert('task list keeps unchecked marker', taskOut.includes('[ ]'));
  assert('task list keeps checked marker', taskOut.includes('[x]'));

  const currency = serializeMarkdown(parseMarkdown('Price is $5 and $10 only\n'));
  assert('currency dollars preserved', currency.includes('$5') && currency.includes('$10'));
  assert('currency not collapsed', !/\$5 and\$/.test(currency));

  const mathOut = serializeMarkdown(parseMarkdown('See $E=mc^2$ here\n'));
  assert('real math survives', mathOut.includes('E=mc^2') || mathOut.includes('$E=mc^2$'));

  const empty = serializeMarkdown(parseMarkdown(''));
  assert('empty document serializes', typeof empty === 'string');

  const frag = serializeMarkdownFragment([
    { type: 'paragraph', content: [{ type: 'text', text: 'fragment-hi' }] },
  ]);
  assert('serializeMarkdownFragment includes text', frag.includes('fragment-hi'));
}

// ---------------------------------------------------------------------------
// Paste heuristics (exported from markdown-paste)
// ---------------------------------------------------------------------------
section('paste heuristics');

{
  assert('plain text is not markdown', !looksLikeMarkdown('hello world'));
  assert('currency alone is not markdown', !looksLikeMarkdown('Price is $5'));
  assert('latex-like single dollar is markdown', looksLikeMarkdown('$E=mc^2$'));
  assert('heading is exclusive markdown', hasExclusiveMarkdownStructure('# Title'));
  assert('two bullets look like markdown', looksLikeMarkdown('- a\n- b'));
  assert('single bullet is not list structure', !looksLikeMarkdown('- only one'));
  assert('ordered list looks like markdown', looksLikeMarkdown('1. a\n2. b'));
  assert('fenced code exclusive', hasExclusiveMarkdownStructure('```\nx\n```'));
}

// ---------------------------------------------------------------------------
// Source markdown highlight
// ---------------------------------------------------------------------------
section('source markdown highlight');

{
  const html = highlightMarkdownSource(
    '# Title\n\n- [x] task\n\n```js\nconst x = 1;\n```\n\n**bold** and $E=mc^2$\n',
  );
  assert('highlight heading marker', html.includes('md-token--heading-marker'));
  assert('highlight list/task', html.includes('md-token--list-marker') || html.includes('md-token--task'));
  assert('highlight fence', html.includes('md-token--fence'));
  assert('highlight strong', html.includes('md-token--strong'));
  assert('highlight math', html.includes('md-token--math'));
  assert('empty highlight non-empty string', highlightMarkdownSource('').length > 0);

  // "a\nbc\nd" offsets: 0=a, 1=\n, 2=b, 3=c → line 2 col 2 at offset 3
  const pos = offsetToLineCol('a\nbc\nd', 3);
  assertEqual('offsetToLineCol line', pos.line, 2);
  assertEqual('offsetToLineCol column', pos.column, 2);
}

// ---------------------------------------------------------------------------
// Search (source)
// ---------------------------------------------------------------------------
section('source search');

{
  const md = 'hello world hello\nHELLO';
  const caseInsensitive = findSourceSearchMatches(md, 'hello', { caseSensitive: false });
  assertEqual('case-insensitive match count', caseInsensitive.length, 3);

  const caseSensitive = findSourceSearchMatches(md, 'hello', { caseSensitive: true });
  assertEqual('case-sensitive match count', caseSensitive.length, 2);

  const first = caseSensitive[0]!;
  const replaced = replaceSourceSearchMatch(md, first, 'hi');
  assertEqual('replace one', replaced.markdown, 'hi world hello\nHELLO');
  assertEqual('replace selection start', replaced.selection.start, 0);
  assertEqual('replace selection end', replaced.selection.end, 2);

  const all = replaceAllSourceSearchMatches(md, 'hello', 'x', { caseSensitive: true });
  assertEqual('replace all count', all.count, 2);
  assertEqual('replace all text', all.markdown, 'x world x\nHELLO');

  const none = replaceAllSourceSearchMatches(md, 'zzz', 'q');
  assertEqual('replace all miss count', none.count, 0);
  assertEqual('replace all miss text', none.markdown, md);
}

// ---------------------------------------------------------------------------
// Outline (must ignore fenced code headings)
// ---------------------------------------------------------------------------
section('outline extraction');

{
  const md = `# Real

\`\`\`
# Not a heading
\`\`\`

## Nested
`;
  const outline = extractOutline(md);
  assert(
    'outline skips fenced fake heading',
    outline.every((item) => item.text !== 'Not a heading'),
    JSON.stringify(outline),
  );
  assert(
    'outline finds real headings',
    outline.some((i) => i.text === 'Real') && outline.some((i) => i.text === 'Nested'),
  );
  assert('outline items have line offsets', outline.every((i) => typeof i.line === 'number' && typeof i.start === 'number'));

  // CRLF: start offsets must land on the first character of each heading line.
  const crlf = '# A\r\n\r\n## B\r\n';
  const crlfOutline = extractOutline(crlf);
  assertEqual('crlf outline count', crlfOutline.length, 2);
  assertEqual('crlf first heading start', crlfOutline[0]!.start, 0);
  assertEqual('crlf first heading char', crlf[crlfOutline[0]!.start], '#');
  assertEqual('crlf second heading start', crlfOutline[1]!.start, 7);
  assertEqual('crlf second heading char', crlf[crlfOutline[1]!.start], '#');
  assert(
    'crlf second is not CR',
    crlf[crlfOutline[1]!.start] !== '\r' && crlf[crlfOutline[1]!.start] !== '\n',
  );

  // Indented ATX heading (up to 3 spaces): start is line start, not '#'.
  const indented = '  ## Indented\n';
  const indOutline = extractOutline(indented);
  assertEqual('indented outline count', indOutline.length, 1);
  assertEqual('indented line start is 0', indOutline[0]!.start, 0);
  assertEqual('indented line starts with space', indented[indOutline[0]!.start], ' ');
  // Selection end for navigation = start of next line ending
  let end = indOutline[0]!.start;
  while (end < indented.length && indented[end] !== '\n' && indented[end] !== '\r') {
    end += 1;
  }
  assertEqual('indented selection text', indented.slice(indOutline[0]!.start, end), '  ## Indented');
}

// ---------------------------------------------------------------------------
// Document stats
// ---------------------------------------------------------------------------
section('document stats');

{
  const s = calculateDocumentStats('hello world\n\n中文');
  assert('stats words includes latin+cjk', s.words >= 3);
  assert('stats lines', s.lines >= 3);
  assert('stats characters positive', s.characters > 0);
  assertEqual('empty stats lines', calculateDocumentStats('').lines, 1);
}

// ---------------------------------------------------------------------------
// Export Markdown → HTML fragment
// ---------------------------------------------------------------------------
section('export markdown → HTML');

{
  const html = markdownToExportHtmlFragment({
    markdown: `# Export

- [ ] todo
- [x] done

Inline $a+b$

| A | B |
| --- | --- |
| 1 | 2 |

\`\`\`js
x
\`\`\`

\`\`\`mermaid
graph LR
  A-->B
\`\`\`
`,
    title: 't',
    baseDir: '/tmp/docs',
  });

  assert('export has h1', html.includes('<h1>'));
  assert('export task checkboxes', html.includes('type="checkbox"'));
  assert('export katex math', html.includes('katex'));
  assert('export table', html.includes('<table'));
  assert('export code block', html.includes('code-block') || html.includes('<pre'));
  assert('export mermaid', html.includes('mermaid'));

  const withImg = markdownToExportHtmlFragment({
    markdown: '![alt](./pic.png)\n',
    baseDir: '/home/user/docs',
  });
  assert('export resolves relative image', withImg.includes('file://') && withImg.includes('pic.png'));
}

// ---------------------------------------------------------------------------
// Clipboard slice serializer (open vs closed slice preference)
// ---------------------------------------------------------------------------
section('clipboard slice serializer');

{
  const openSlice = {
    content: {
      toJSON: () => [{ type: 'paragraph', content: [{ type: 'text', text: 'cell' }] }],
    },
    openStart: 1,
    openEnd: 1,
  };
  const openText = serializeSliceForClipboard(openSlice);
  assertEqual('open slice prefers plain leaf text', openText, 'cell');

  const multi = {
    content: {
      toJSON: () => [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    },
    openStart: 0,
    openEnd: 0,
  };
  const multiMd = serializeSliceForClipboard(multi);
  assert('closed multi-block yields markdown-ish text', multiMd.includes('a') && multiMd.includes('b'));

  // Full table slice → TSV (Excel/Word plain paste)
  const tableSlice = {
    content: {
      toJSON: () => [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '1' }] }] },
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '2' }] }] },
              ],
            },
          ],
        },
      ],
    },
    openStart: 0,
    openEnd: 0,
  };
  const tableTsv = serializeSliceForClipboard(tableSlice);
  assertEqual('table slice serializes as TSV', tableTsv, 'A\tB\n1\t2');
}

// ---------------------------------------------------------------------------
// Table matrix helpers (multi-cell copy → Excel / Word)
// ---------------------------------------------------------------------------
section('table clipboard matrix helpers');

{
  const matrix = [
    ['Name', 'Age'],
    ['Alice', '30'],
    ['Bob', '1\t2'],
  ];

  const tsv = tableMatrixToTsv(matrix);
  assertEqual('tsv first row', tsv.split('\n')[0], 'Name\tAge');
  assert('tsv has alice row', tsv.includes('Alice\t30'));
  assertEqual('tsv quotes tab-containing cell', tsv.split('\n')[2], 'Bob\t"1\t2"');

  const html = tableMatrixToHtml(matrix, true);
  assert('html has table', html.includes('<table'));
  assert('html has th headers', html.includes('<th>Name</th>') && html.includes('<th>Age</th>'));
  assert('html has both body cells', html.includes('<td>Alice</td>') && html.includes('<td>30</td>'));
  assert('html has second row', html.includes('<td>Bob</td>') && html.includes('1\t2'));
  assert('html escapes angle brackets', tableMatrixToHtml([['<x>']], false).includes('&lt;x&gt;'));

  const md = tableMatrixToMarkdown(matrix);
  assert('md has pipes', md.includes('| Name | Age |'));
  assert('md has separator', md.includes('| --- | --- |'));
  assert('md has alice', md.includes('| Alice | 30 |'));

  // Multi-cell matrix must not collapse to first cell only
  const twoByTwo = tableMatrixToTsv([
    ['A', 'B'],
    ['C', 'D'],
  ]);
  assertEqual('2x2 all four cells', twoByTwo, 'A\tB\nC\tD');
  assert('2x2 not first-only', twoByTwo !== 'A' && !/^A\s*$/.test(twoByTwo));
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.error('\nFailures:');
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log('All pure-logic tests passed.');
process.exit(0);
