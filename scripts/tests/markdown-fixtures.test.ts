import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseMarkdown, serializeMarkdown } from '../../src/renderer/editor/markdown.ts';
import { highlightMarkdownSource } from '../../src/renderer/editor/markdown-highlight.ts';
import { markdownToExportHtmlFragment } from '../../src/main/export/markdown-to-html.ts';

const fixturesDir = fileURLToPath(
  new URL('../../tests/fixtures/markdown/', import.meta.url),
);
const imagesDir = fileURLToPath(
  new URL('../../tests/fixtures/images/', import.meta.url),
);

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
  failures.push(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function assertEqual(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function countNodeType(content: unknown, typeName: string): number {
  const nodes = Array.isArray(content) ? content : [content];
  let count = 0;
  for (const node of nodes) {
    if (!node || typeof node !== 'object') {
      continue;
    }
    const item = node as { type?: unknown; content?: unknown };
    if (item.type === typeName) {
      count += 1;
    }
    count += countNodeType(item.content, typeName);
  }
  return count;
}

function countTextOccurrences(content: unknown, needle: string): number {
  const stack: unknown[] = [content];
  let count = 0;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') {
      continue;
    }
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    const record = current as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      count += (record.text.match(new RegExp(escaped, 'g')) ?? []).length;
    }
    if (typeof record.html === 'string') {
      count += (record.html.match(new RegExp(escaped, 'g')) ?? []).length;
    }
    if (typeof record.code === 'string') {
      count += (record.code.match(new RegExp(escaped, 'g')) ?? []).length;
    }
    const attrs = record.attrs as Record<string, unknown> | undefined;
    if (typeof attrs?.html === 'string') {
      count += (attrs.html.match(new RegExp(escaped, 'g')) ?? []).length;
    }
    if (typeof attrs?.code === 'string') {
      count += (attrs.code.match(new RegExp(escaped, 'g')) ?? []).length;
    }
    if (Array.isArray(record.content)) {
      stack.push(record.content);
    }
  }

  return count;
}

console.log('\n## markdown fixture round-trips');

const files = fs
  .readdirSync(fixturesDir)
  .filter((file) => file.endsWith('.md'))
  .sort();

assert('fixture directory contains markdown files', files.length >= 6, files.join(', '));

for (const file of files) {
  const source = fs.readFileSync(path.join(fixturesDir, file), 'utf8');
  const json = parseMarkdown(source);
  const jsonText = JSON.stringify(json);
  const markdown = serializeMarkdown(json);
  const markdownAgain = serializeMarkdown(parseMarkdown(markdown));
  const sourceTokenCount = (source.match(/MARKDOWN_EDITOR/g) ?? []).length;
  const jsonTokenCount = (jsonText.match(/MARKDOWN_EDITOR/g) ?? []).length;
  const markdownTokenCount = (markdown.match(/MARKDOWN_EDITOR/g) ?? []).length;

  if (sourceTokenCount > 0) {
    assertEqual(
      `${file}: literal token-like text is preserved`,
      markdownTokenCount,
      sourceTokenCount,
    );
    assert(
      `${file}: literal token survives round-trip`,
      markdown.includes('@@MARKDOWN_EDITOR_MATH_0@@') ||
        markdown.includes('@@MARKDOWN_EDITOR_MATH_999@@') ||
        markdown.includes('@@MARKDOWN_EDITOR_MATH_42@@'),
    );
  } else {
    assertEqual(`${file}: no tokens in JSON`, jsonTokenCount, 0);
    assertEqual(`${file}: no tokens in Markdown`, markdownTokenCount, 0);
  }

  assertEqual(`${file}: second round-trip is stable`, markdownAgain, markdown);
  assert(
    `${file}: non-empty input stays non-empty`,
    source.trim().length === 0 || markdown.trim().length > 0,
  );
  const previewAgain = parseMarkdown(markdown);
  const sourceAfterPreviewAgain = serializeMarkdown(previewAgain);
  assertEqual(
    `${file}: source/preview mode switch is stable`,
    sourceAfterPreviewAgain,
    markdown,
  );
  if (sourceTokenCount > 0) {
    const previewTokenCount = (sourceAfterPreviewAgain.match(/MARKDOWN_EDITOR/g) ?? []).length;
    assertEqual(
      `${file}: source/preview mode switch preserves literal tokens`,
      previewTokenCount,
      sourceTokenCount,
    );
  } else {
    assert(
      `${file}: source/preview mode switch keeps no tokens`,
      !sourceAfterPreviewAgain.includes('MARKDOWN_EDITOR'),
    );
  }
}

// Focused invariants for the tricky classes that previously leaked tokens.
{
  const code = fs.readFileSync(path.join(fixturesDir, 'code-blocks.md'), 'utf8');
  const codeJson = parseMarkdown(code);
  assertEqual('code fixture has codeBlock nodes', countNodeType(codeJson, 'codeBlock'), 3);
  assertEqual('code fixture has no inline math nodes', countNodeType(codeJson, 'inlineMath'), 0);
  assertEqual(
    'code fixture keeps dollar text inside code',
    countTextOccurrences(codeJson, '$x^2 + y^2 = z^2$'),
    1,
  );

  const html = fs.readFileSync(path.join(fixturesDir, 'html.md'), 'utf8');
  const htmlJson = parseMarkdown(html);
  assertEqual('html fixture has htmlBlock nodes', countNodeType(htmlJson, 'htmlBlock'), 1);
  assertEqual(
    'html fixture keeps paragraph math but not html math',
    countNodeType(htmlJson, 'inlineMath'),
    1,
  );
  assertEqual('html fixture keeps dollar text inside html', countTextOccurrences(htmlJson, '$a+b$'), 1);

  const paper = fs.readFileSync(path.join(fixturesDir, 'paper-latex.md'), 'utf8');
  const paperJson = parseMarkdown(paper);
  assertEqual('paper-like fixture has codeBlock node', countNodeType(paperJson, 'codeBlock'), 1);
  assertEqual('paper-like fixture has no inline math nodes', countNodeType(paperJson, 'inlineMath'), 0);
  assertEqual(
    'paper-like fixture keeps LaTeX math inside code',
    countTextOccurrences(paperJson, 'X_0,X_1'),
    1,
  );

  const math = fs.readFileSync(path.join(fixturesDir, 'math.md'), 'utf8');
  const mathMarkdown = serializeMarkdown(parseMarkdown(math));
  assert(
    'math fixture keeps inline and block delimiters',
    mathMarkdown.includes('$E=mc^2$') &&
      mathMarkdown.includes('a+b=c') &&
      mathMarkdown.includes('$$') &&
      mathMarkdown.includes('\\(x^2\\)'),
  );
}


// Image fixture: opening + source/preview switching.
{
  const imagePath = path.join(imagesDir, 'dora.png');
  const imageBytes = fs.readFileSync(imagePath);
  assert('image fixture dora.png exists', imageBytes.length > 0);
  assert(
    'image fixture is a valid image file',
    imageBytes[0] === 0xff && imageBytes[1] === 0xd8 && imageBytes[2] === 0xff,
  );

  const imageMarkdown = fs.readFileSync(path.join(fixturesDir, 'images.md'), 'utf8');
  const imageJson = parseMarkdown(imageMarkdown);
  const imageJsonText = JSON.stringify(imageJson);
  assert('image fixture parses to image node', imageJsonText.includes('"type":"image"'));
  assert(
    'image fixture keeps relative source',
    imageJsonText.includes('"src":"../images/dora.png"'),
  );

  const imageMarkdownOut = serializeMarkdown(imageJson);
  assert(
    'image fixture source mode keeps markdown',
    imageMarkdownOut.includes('![Dora](../images/dora.png'),
  );

  const sourceHighlight = highlightMarkdownSource(imageMarkdown);
  assert('source mode highlights image syntax', sourceHighlight.includes('md-token--image'));

  const previewHtml = markdownToExportHtmlFragment({
    markdown: imageMarkdown,
    baseDir: fixturesDir,
  });
  const expectedImageUrl = pathToFileURL(path.join(imagesDir, 'dora.png')).toString();
  assert(
    'preview mode resolves image src to fixture',
    previewHtml.includes(expectedImageUrl) && previewHtml.includes('alt="Dora"'),
  );
}
console.log(`\n================================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
