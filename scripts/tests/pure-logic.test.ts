/**
 * Automated tests against SHIPPED pure-logic entry points.
 * Run: npx tsx scripts/tests/pure-logic.test.ts
 */
import { parseMarkdown, serializeMarkdown, serializeMarkdownFragment } from '../../src/renderer/editor/markdown.ts';
import { cleanSelectionMarkersFromJsonContent } from '../../src/renderer/editor/selection-markers';
import { highlightMarkdownSource, offsetToLineCol } from '../../src/renderer/editor/markdown-highlight.ts';
import {
  getSourceEditorVisibleRange,
  highlightVisibleSourceRange,
} from '../../src/renderer/components/SourceEditor.tsx';
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
import { extractOutline, formatFolderDate } from '../../src/renderer/utils/document.ts';
import { markdownToExportHtmlFragment } from '../../src/main/export/markdown-to-html.ts';
import {
  isPartialInsideWrapperParent,
  isWholeNodeSelection,
  serializeSliceForClipboard,
  tableMatrixToHtml,
  tableMatrixToMarkdown,
  tableMatrixToTsv,
} from '../../src/renderer/editor/clipboard.ts';
import {
  LIQUID_GLASS_CONFIG,
  LIQUID_GLASS_SURFACE_SELECTOR,
} from '../../src/renderer/effects/liquid-glass.ts';
import {
  buildThemeGradientStyles,
  GLASS_EFFECT_OPTIONS,
  isGlassEffect,
} from '../../src/renderer/theme.ts';
import {
  getMathCompletionCaret,
  getMathCompletionItems,
  MATH_COMPLETIONS,
} from '../../src/renderer/editor/math-completions.ts';
import {
  hexToRgb,
  isHexColor,
  resolveCustomColorsEnabled,
  rgbToHex,
} from '../../src/renderer/settings.ts';
import { setAppLanguage, translate } from '../../src/renderer/i18n.ts';
import {
  clearFormulaHtmlCache,
  getCachedFormulaHtml,
  getFormulaCacheKey,
  seedFormulaHtmlCache,
} from '../../src/renderer/editor/math-render-cache.ts';
import {
  collectFormulaIndex,
  renderFormulaChunk,
  splitFormulaChunks,
} from '../../src/renderer/editor/markdown.worker.ts';
import {
  clearImagePreloadCache,
  getImagePreloadState,
  preloadImageSource,
} from '../../src/renderer/editor/image-preload.ts';
import {
  clearMermaidHeightCache,
  getCachedMermaidHeight,
  getMermaidCacheKey,
  setCachedMermaidHeight,
} from '../../src/renderer/editor/mermaid-cache.ts';
import {
  clearNodeHeightCache,
  getCachedNodeHeight,
  getHeightCacheKey,
  notifyNodeHeightCacheSeeded,
  setCachedNodeHeight,
  subscribeNodeHeightCacheInvalidation,
  subscribeNodeHeightCacheSeeded,
  unsubscribeNodeHeightCacheInvalidation,
} from '../../src/renderer/editor/virtualization/height-cache.ts';
import {
  buildFormulaHeightMeasurementItems,
  measureFormulaHeights,
} from '../../src/renderer/editor/virtualization/height-measurer.ts';
import { createHydrationQueue } from '../../src/renderer/editor/virtualization/hydration-queue.ts';

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

  for (const [newlines, expectedBlank] of [[2, 0], [3, 1], [4, 2]] as const) {
    const source = `$$\nx\n$$${'\n'.repeat(newlines)}abc\n`;
    const doc = parseMarkdown(source);
    const attrs = doc.content?.[0]?.attrs as Record<string, unknown> | undefined;
    assert(
      `display math trailing blank ${expectedBlank} is preserved`,
      Number(attrs?.trailingBlankLines ?? 0) === expectedBlank,
      JSON.stringify(attrs),
    );
    assertEqual(
      `display math trailing blank ${expectedBlank} round-trips`,
      serializeMarkdown(doc),
      source,
    );
  }

  const plainDoc = parseMarkdown('Hello plain world\n');
  assert('plain text parses as ordinary text', JSON.stringify(plainDoc).includes('"type":"text"'));
  assert('plain text serializes without math tokens', !serializeMarkdown(plainDoc).includes('\uE000'));

  const inlineMathDoc = parseMarkdown('$x^2$\n');
  assert('single-dollar math parses as inlineMath', JSON.stringify(inlineMathDoc).includes('"type":"inlineMath"'));
  assert('single-dollar math preserves content', JSON.stringify(inlineMathDoc).includes('x^2'));

  const malformedMathOut = serializeMarkdown(parseMarkdown('unclosed $x^2\n'));
  assert('malformed math does not leak placeholder token', !malformedMathOut.includes('\uE000') && malformedMathOut.includes('$x^2'));

  const multipleMathOut = serializeMarkdown(parseMarkdown('$x^2$ and $y^2$\n'));
  assert('multiple math placeholders restore without leakage', !multipleMathOut.includes('\uE000') && multipleMathOut.includes('$x^2$') && multipleMathOut.includes('$y^2$'));

  const indentedCodeMath = serializeMarkdown(
    parseMarkdown('Before\n\n    $x^2 + y^2 = z^2$\n\nAfter\n'),
  );
  assert(
    'indented code math stays raw',
    !indentedCodeMath.includes('MARKDOWN_EDITOR') && indentedCodeMath.includes('$x^2 + y^2 = z^2$'),
  );

  const indentedCodeNested = serializeMarkdown(
    parseMarkdown('Before\n\n    `$a$` and $b$\n\nAfter\n'),
  );
  assert(
    'indented code nested markers stay raw',
    !indentedCodeNested.includes('MARKDOWN_EDITOR') &&
      indentedCodeNested.includes('`$a$` and $b$'),
  );

  const htmlWithMath = serializeMarkdown(parseMarkdown('<div>\n$a+b$\n</div>\n'));
  assert(
    'html math stays raw',
    !htmlWithMath.includes('MARKDOWN_EDITOR') && htmlWithMath.includes('$a+b$'),
  );

  const literalToken = serializeMarkdown(
    parseMarkdown('literal @@MARKDOWN_EDITOR_MATH_0@@ text\n'),
  );
  assert(
    'literal token-like text is preserved',
    literalToken.includes('@@MARKDOWN_EDITOR_MATH_0@@'),
  );

  const empty = serializeMarkdown(parseMarkdown(''));
  assert('empty document serializes', typeof empty === 'string');

  const frag = serializeMarkdownFragment([
    { type: 'paragraph', content: [{ type: 'text', text: 'fragment-hi' }] },
  ]);
  assert('serializeMarkdownFragment includes text', frag.includes('fragment-hi'));
}

// ---------------------------------------------------------------------------
// Math render cache LRU lifecycle
// ---------------------------------------------------------------------------
section('math render cache LRU');

{
  clearFormulaHtmlCache();
  const lruEntries: Record<string, string> = {};
  for (let index = 0; index < 10_005; index += 1) {
    const display = index % 2 === 0 ? 'no' : 'yes';
    lruEntries[getFormulaCacheKey(`formula-${index}`, display)] = `<span>${index}</span>`;
  }

  assertEqual('math cache LRU seed count', seedFormulaHtmlCache(lruEntries), 10_005);
  assert(
    'math cache LRU evicts oldest entries after overflow',
    getCachedFormulaHtml('formula-0', 'no') === null &&
      getCachedFormulaHtml('formula-10004', 'no') === '<span>10004</span>',
    `oldest=${String(getCachedFormulaHtml('formula-0', 'no'))} newest=${String(getCachedFormulaHtml('formula-10004', 'no'))}`,
  );
  assert(
    'math cache LRU get promotes recently used entry',
    getCachedFormulaHtml('formula-5', 'yes') === '<span>5</span>',
    String(getCachedFormulaHtml('formula-5', 'yes')),
  );
  seedFormulaHtmlCache({
    [getFormulaCacheKey('formula-10005', 'yes')]: '<span>10005</span>',
  });
  assert(
    'math cache LRU evicts oldest after promoted hit',
    getCachedFormulaHtml('formula-5', 'yes') === '<span>5</span>' &&
      getCachedFormulaHtml('formula-6', 'no') === null &&
      getCachedFormulaHtml('formula-10005', 'yes') === '<span>10005</span>',
    `promoted=${String(getCachedFormulaHtml('formula-5', 'yes'))} nextOldest=${String(getCachedFormulaHtml('formula-6', 'no'))} newest=${String(getCachedFormulaHtml('formula-10005', 'yes'))}`,
  );
  clearFormulaHtmlCache();
}

// ---------------------------------------------------------------------------
// Formula HTML index
// ---------------------------------------------------------------------------
section('formula html index');

{
  const content = parseMarkdown('$x^2$ and $y^2$\n\n$$\nz^2\n$$\n');
  const index = collectFormulaIndex(content);

  assert(
    'formula index entries include key, latex, and display',
    index.length === 3 &&
      index.every(
        (entry) =>
          typeof entry.key === 'string' &&
          typeof entry.latex === 'string' &&
          (entry.display === 'yes' || entry.display === 'no'),
      ),
    JSON.stringify(index),
  );

  const inlineX = index.find((entry) => entry.latex === 'x^2' && entry.display === 'no');
  assertEqual('formula index key matches cache key', inlineX?.key, getFormulaCacheKey('x^2', 'no'));

  const blockZ = index.find((entry) => entry.latex === 'z^2' && entry.display === 'yes');
  assert('formula index includes block display', Boolean(blockZ), JSON.stringify(index));

  const duplicateContent = parseMarkdown('$x^2$ and $x^2$\n');
  assertEqual(
    'formula index deduplicates identical formulas',
    collectFormulaIndex(duplicateContent).length,
    1,
  );
}

// ---------------------------------------------------------------------------
// Formula chunk rendering
// ---------------------------------------------------------------------------
section('formula chunk rendering');

{
  const entries = [
    { key: getFormulaCacheKey('x^2', 'no'), latex: 'x^2', display: 'no' as const },
    { key: getFormulaCacheKey('y^2', 'yes'), latex: 'y^2', display: 'yes' as const },
  ];
  const rendered = renderFormulaChunk(entries);

  assert(
    'formula chunk renders every requested entry',
    Object.keys(rendered).length === 2 &&
      typeof rendered[entries[0]!.key] === 'string' &&
      typeof rendered[entries[1]!.key] === 'string',
    JSON.stringify(Object.keys(rendered)),
  );
  assert(
    'formula chunk output contains katex html',
    rendered[entries[0]!.key]?.includes('katex') === true &&
      rendered[entries[1]!.key]?.includes('katex') === true,
    String(rendered[entries[0]!.key]?.slice(0, 80)),
  );
  assertEqual('formula chunk renders empty input', renderFormulaChunk([]), {});
  const splitEntries = collectFormulaIndex(parseMarkdown('$a$ $b$ $c$ $d$ $e$\n'));
  const chunks = splitFormulaChunks(splitEntries, 2);
  assertEqual(
    'formula chunk split preserves all entries',
    chunks.flat().map((entry) => entry.key),
    splitEntries.map((entry) => entry.key),
  );
  assertEqual('formula chunk split creates expected chunk count', chunks.length, 3);
  const measuredItems = buildFormulaHeightMeasurementItems(splitEntries, renderFormulaChunk(splitEntries));
  assertEqual(
    'formula height measurement items mirror formula chunk keys',
    measuredItems.length,
    splitEntries.length,
  );
}

// ---------------------------------------------------------------------------
// Image preload cache deduplication / LRU
// ---------------------------------------------------------------------------
section('image preload cache');

{
  clearImagePreloadCache();

  const globals = globalThis as Record<string, unknown>;
  const previousImage = globals.Image;
  let imageRequestCount = 0;
  let lastRequestedSource = '';

  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    complete = false;

    set src(value: string) {
      imageRequestCount += 1;
      lastRequestedSource = value;
      if (value.startsWith('fail:')) {
        this.complete = false;
        this.onerror?.();
        return;
      }
      this.complete = true;
      this.onload?.();
    }
  }

  globals.Image = FakeImage;

  try {
    const firstPromise = preloadImageSource('https://example.com/a.png');
    const duplicatePromise = preloadImageSource('https://example.com/a.png');
    assert(
      'image preload deduplicates in-flight URL',
      firstPromise === duplicatePromise && imageRequestCount === 1,
      `requests=${imageRequestCount}`,
    );
    assertEqual('image preload records ready state', getImagePreloadState('https://example.com/a.png'), 'ready');

    const readyAgain = preloadImageSource('https://example.com/a.png');
    assert(
      'image preload keeps ready URL cached',
      readyAgain === firstPromise && imageRequestCount === 1,
      `requests=${imageRequestCount}`,
    );

    const failedPromise = preloadImageSource('fail:bad.png');
    const failedAgain = preloadImageSource('fail:bad.png');
    assertEqual('image preload records failed state', getImagePreloadState('fail:bad.png'), 'failed');
    assert(
      'image preload does not retry failed URL',
      failedPromise === failedAgain && imageRequestCount === 2,
      `requests=${imageRequestCount}`,
    );

    for (let index = 0; index < 210; index += 1) {
      preloadImageSource(`https://example.com/lru-${index}.png`);
    }
    assertEqual('image preload LRU evicts oldest URL', getImagePreloadState('https://example.com/lru-0.png'), null);
    assertEqual('image preload LRU keeps newest URL', getImagePreloadState('https://example.com/lru-209.png'), 'ready');
    assertEqual('image preload LRU last requested source', lastRequestedSource, 'https://example.com/lru-209.png');

    clearImagePreloadCache();
    assertEqual('image preload clear empties cache', getImagePreloadState('https://example.com/a.png'), null);
  } finally {
    if (previousImage === undefined) {
      delete globals.Image;
    } else {
      globals.Image = previousImage;
    }
  }
}

// ---------------------------------------------------------------------------
// Mermaid height cache
// ---------------------------------------------------------------------------
section('mermaid height cache');

{
  clearMermaidHeightCache();

  const code = 'graph LR\n  A-->B';
  assertEqual(
    'mermaid height cache key uses null separator',
    getMermaidCacheKey('dark', code),
    `dark\u0000${code}`,
  );
  assertEqual(
    'mermaid height cache starts empty',
    getCachedMermaidHeight('base', code),
    null,
  );

  setCachedMermaidHeight('dark', code, 220);
  assertEqual('mermaid height cache get after set', getCachedMermaidHeight('dark', code), 220);
  assertEqual(
    'mermaid height cache isolates theme',
    getCachedMermaidHeight('base', code),
    null,
  );

  setCachedMermaidHeight('base', code, 180);
  assertEqual(
    'mermaid height cache keeps both themes',
    getCachedMermaidHeight('dark', code) === 220 && getCachedMermaidHeight('base', code) === 180,
    true,
  );

  clearMermaidHeightCache();
  assertEqual(
    'mermaid height cache clear empties cache',
    getCachedMermaidHeight('dark', code),
    null,
  );
}

// ---------------------------------------------------------------------------
// Height measurer fallback without browser layout
// ---------------------------------------------------------------------------
section('height measurer no DOM');

{
  const empty = await measureFormulaHeights([]);
  assertEqual('height measurer empty batch returns empty record', empty, {});

  const fallback = await measureFormulaHeights([
    { key: 'height-measurer-fallback-key', html: '<span>x</span>', display: 'yes' as const },
  ]);
  assertEqual('height measurer returns empty without real layout', fallback, {});
}

// ---------------------------------------------------------------------------
// Hydration queue (drag-target priority and eviction)
// ---------------------------------------------------------------------------
section('hydration queue');

{
  const queue = createHydrationQueue();
  queue.enqueue({ id: 'far', position: 500 });
  queue.enqueue({ id: 'near', position: 90 });
  queue.enqueue({ id: 'closest', position: 102 });
  assertEqual('hydration queue returns closest to center first', queue.next(100)?.id, 'closest');
  assertEqual('hydration queue returns next nearest', queue.next(100)?.id, 'near');
  assertEqual('hydration queue returns remaining task', queue.next(100)?.id, 'far');
  assertEqual('hydration queue empties after next', queue.size, 0);
}

{
  const queue = createHydrationQueue();
  queue.enqueue({ id: 'same-old', position: 50, priority: 0 });
  queue.enqueue({ id: 'same-new', position: 50, priority: 0 });
  assertEqual(
    'hydration queue breaks distance ties with LIFO',
    queue.next(0)?.id,
    'same-new',
  );
}

{
  const queue = createHydrationQueue();
  queue.enqueue({ id: 'low', position: 50, priority: 0 });
  queue.enqueue({ id: 'high', position: 50, priority: 1 });
  assertEqual(
    'hydration queue breaks distance ties by priority',
    queue.next(0)?.id,
    'high',
  );
}

{
  const queue = createHydrationQueue();
  queue.enqueue({ id: 'far', position: 500 });
  queue.enqueue({ id: 'closest', position: 10 });
  queue.enqueue({ id: 'inside-old', position: 30, priority: 0 });
  queue.enqueue({ id: 'inside-new', position: 30, priority: 0 });
  queue.enqueue({ id: 'inside-high', position: 30, priority: 1 });
  queue.enqueue({ id: 'near', position: 90 });
  queue.enqueue({ id: 'edge', position: 100 });
  assertEqual(
    'hydration queue nextWithin drains closest in-radius task first',
    queue.nextWithin(100, 0)?.id,
    'closest',
  );
  assertEqual(
    'hydration queue nextWithin drains same-distance priority before LIFO',
    queue.nextWithin(100, 0)?.id,
    'inside-high',
  );
  assertEqual(
    'hydration queue nextWithin drains same-distance LIFO after priority',
    queue.nextWithin(100, 0)?.id,
    'inside-new',
  );
  assertEqual(
    'hydration queue nextWithin drains older same-distance task after LIFO',
    queue.nextWithin(100, 0)?.id,
    'inside-old',
  );
  assertEqual(
    'hydration queue nextWithin drains remaining nearer in-radius task',
    queue.nextWithin(100, 0)?.id,
    'near',
  );
  assertEqual(
    'hydration queue nextWithin includes exact radius boundary',
    queue.nextWithin(100, 0)?.id,
    'edge',
  );
  assertEqual(
    'hydration queue nextWithin returns null after in-radius tasks are drained',
    queue.nextWithin(100, 0)?.id ?? null,
    null,
  );
  assertEqual(
    'hydration queue nextWithin leaves out-of-radius tasks queued',
    queue.size,
    1,
  );
  assertEqual(
    'hydration queue nextWithin preserves out-of-radius task order',
    queue.next(0)?.id,
    'far',
  );
  assertEqual('hydration queue empties after outside task is consumed', queue.size, 0);
}

{
  const queue = createHydrationQueue();
  queue.enqueue({ id: 'inside', position: 20 });
  queue.enqueue({ id: 'edge', position: 50 });
  queue.enqueue({ id: 'outside', position: 100 });
  assertEqual('hydration queue evicts far tasks', queue.evictOutside(50, 0), 1);
  assertEqual('hydration queue keeps in-range tasks', queue.size, 2);
  queue.evictOutside(50, 0);
  assertEqual('hydration queue evict is idempotent', queue.size, 2);
  queue.clear();
  assertEqual('hydration queue clear empties tasks', queue.size, 0);
}

// ---------------------------------------------------------------------------
// Node height cache (LRU)
// ---------------------------------------------------------------------------
section('node height cache');

{
  clearNodeHeightCache();

  const keyA = getHeightCacheKey('inlineMath', 'x^2', 6, 'light:default', 1, 'default');
  const keyB = getHeightCacheKey('inlineMath', 'x^2', 7, 'light:default', 1, 'default');
  assertEqual('node height cache key is stable', getHeightCacheKey('inlineMath', 'x^2', 6, 'light:default', 1, 'default'), keyA);
  assert('node height cache key includes width bucket', keyA !== keyB, `${keyA} vs ${keyB}`);
  assertEqual('node height cache starts empty', getCachedNodeHeight(keyA), null);

  setCachedNodeHeight(keyA, 96);
  assertEqual('node height cache get after set', getCachedNodeHeight(keyA), 96);
  setCachedNodeHeight(keyA, 112);
  assertEqual('node height cache set updates value', getCachedNodeHeight(keyA), 112);

  clearNodeHeightCache();
  assertEqual('node height cache clear empties cache', getCachedNodeHeight(keyA), null);

  const lruKeys = Array.from({ length: 5006 }, (_, index) =>
    getHeightCacheKey('inlineMath', `formula-${index}`, 1, 'light', 1, 'v1'),
  );
  for (let index = 0; index < 5005; index += 1) {
    setCachedNodeHeight(lruKeys[index]!, index);
  }
  assertEqual('node height cache LRU evicts oldest entries', getCachedNodeHeight(lruKeys[0]!), null);
  assertEqual('node height cache LRU keeps newest entry', getCachedNodeHeight(lruKeys[5004]!), 5004);

  getCachedNodeHeight(lruKeys[5]!);
  setCachedNodeHeight(lruKeys[5005]!, 5005);
  assertEqual('node height cache LRU keeps promoted entry', getCachedNodeHeight(lruKeys[5]!), 5);
  assertEqual('node height cache LRU evicts next oldest', getCachedNodeHeight(lruKeys[6]!), null);
  assertEqual('node height cache LRU keeps newest after overflow', getCachedNodeHeight(lruKeys[5005]!), 5005);

  const invalidationEvents: string[] = [];
  const firstCallback = () => invalidationEvents.push('first');
  const secondCallback = () => invalidationEvents.push('second');
  const firstUnsubscribe = subscribeNodeHeightCacheInvalidation(firstCallback);
  subscribeNodeHeightCacheInvalidation(secondCallback);
  setCachedNodeHeight(keyA, 96);
  clearNodeHeightCache();
  assertEqual(
    'node height cache invalidation notifies subscribers on clear',
    invalidationEvents,
    ['first', 'second'],
  );
  assertEqual('node height cache invalidation clears cached height', getCachedNodeHeight(keyA), null);

  firstUnsubscribe();
  clearNodeHeightCache();
  assertEqual(
    'node height cache unsubscribe stops notifications',
    invalidationEvents,
    ['first', 'second', 'second'],
  );

  unsubscribeNodeHeightCacheInvalidation(secondCallback);
  clearNodeHeightCache();
  assertEqual(
    'node height cache fully unsubscribed listeners are silent',
    invalidationEvents,
    ['first', 'second', 'second'],
  );

  const seededEvents: string[] = [];
  const unsubscribeSeeded = subscribeNodeHeightCacheSeeded(() => {
    seededEvents.push('seeded');
  });
  setCachedNodeHeight(keyA, 96);
  notifyNodeHeightCacheSeeded();
  assertEqual(
    'node height cache seeded notification fires',
    seededEvents,
    ['seeded'],
  );
  unsubscribeSeeded();
  notifyNodeHeightCacheSeeded();
  assertEqual(
    'node height cache seeded notification unsubscribes',
    seededEvents,
    ['seeded'],
  );

  clearNodeHeightCache();
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
  const firstUncommittedLine = highlightVisibleSourceRange('abc', 0, 1);
  assert(
    'source typing is visible before the first newline',
    firstUncommittedLine.includes('abc'),
    JSON.stringify(firstUncommittedLine),
  );
  const lastUncommittedLine = highlightVisibleSourceRange('a\nbc', 1, 2);
  assert(
    'source virtualization includes a final line without a newline',
    lastUncommittedLine.includes('bc') && !lastUncommittedLine.includes('a\n'),
    JSON.stringify(lastUncommittedLine),
  );
  const beyondLastLine = highlightVisibleSourceRange('abc', 1, 2);
  assert(
    'source virtualization leaves absent lines empty',
    beyondLastLine === '\n' || beyondLastLine === '',
    JSON.stringify(beyondLastLine),
  );
  const visibleRange = getSourceEditorVisibleRange(10_000, 24_000, 600, {
    lineHeight: 24,
    paddingTop: 28,
  });
  assert(
    'source virtualization starts around the textarea viewport',
    visibleRange.start >= 970 &&
      visibleRange.start <= 1_020 &&
      visibleRange.endExclusive > visibleRange.start + 150,
    JSON.stringify(visibleRange),
  );
  const fenced = 'before\n```js\nconst value = 1;\n```\nafter\n';
  const fencedHtml = highlightVisibleSourceRange(fenced, 2, 3);
  assert(
    'source virtualization preserves fence context',
    fencedHtml.includes('md-token--codeblock') &&
      fencedHtml.includes('value') &&
      !fencedHtml.includes('md-token--fence'),
    fencedHtml,
  );

  // "a\nbc\nd" offsets: 0=a, 1=\n, 2=b, 3=c → line 2 col 2 at offset 3
  const pos = offsetToLineCol('a\nbc\nd', 3);
  assertEqual('offsetToLineCol line', pos.line, 2);
  assertEqual('offsetToLineCol column', pos.column, 2);
}

// ---------------------------------------------------------------------------
// Liquid glass configuration
// ---------------------------------------------------------------------------
section('liquid glass configuration');

{
  assert('liquid glass is an accepted theme option', isGlassEffect('liquid'));
  assert(
    'liquid glass appears in the glass effect menu',
    GLASS_EFFECT_OPTIONS.some((option) => option.id === 'liquid'),
  );
  assert(
    'liquid glass uses stronger blur than the upstream default',
    LIQUID_GLASS_CONFIG.blurAmount >= 5,
  );
  assert(
    'liquid glass uses thicker glass than the upstream default',
    LIQUID_GLASS_CONFIG.glassThickness >= 150,
  );
  assert(
    'liquid glass keeps enough map resolution for larger surfaces',
    LIQUID_GLASS_CONFIG.maxMapSize >= 512,
  );
  assert(
    'liquid glass edge highlights are strong enough to distinguish from frosted glass',
    LIQUID_GLASS_CONFIG.specularOpacity >= 0.6,
  );
  const requiredSurfaces = [
    '.toolbar',
    '.sidebar',
    '.status-bar',
    '.context-menu',
    '.toolbar-menu',
    '.toolbar-submenu',
    '.theme-panel',
    '.image-action-menu',
    '.math-completion',
    '.settings-dialog',
    '.app-dialog',
  ];
  for (const selector of requiredSurfaces) {
    assert(
      `liquid glass surface list includes ${selector}`,
      LIQUID_GLASS_SURFACE_SELECTOR.includes(selector),
    );
  }
  assert(
    'code language menu is excluded from liquid glass surfaces',
    !LIQUID_GLASS_SURFACE_SELECTOR.includes('.code-block-node__language-menu'),
  );
}

// ---------------------------------------------------------------------------
// Math completion
// ---------------------------------------------------------------------------
section('math completion');

{
  const fracItems = getMathCompletionItems('fr');
  assert('math completion finds frac for \\fr', fracItems.some((item) => item.command === 'frac'));
  assertEqual('math completion caret goes inside first braces', getMathCompletionCaret('\\frac{}{}'), 6);
  assertEqual('math completion caret for simple command', getMathCompletionCaret('\\alpha'), 6);
  const emptyQueryItems = getMathCompletionItems('');
  assert('math completion empty query returns suggestions', emptyQueryItems.length > 0);
  assert('math completion library is broad', MATH_COMPLETIONS.length > 150, String(MATH_COMPLETIONS.length));
  assert(
    'math completion matches uppercase Greek from lowercase query',
    getMathCompletionItems('G').some((item) => item.command === 'Gamma'),
  );
  assert(
    'math completion includes environments',
    getMathCompletionItems('bm').some((item) => item.command === 'bmatrix'),
  );
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------
section('settings helpers');

{
  assert('hex color accepts six-digit rgb hex', isHexColor('#4d7592'));
  assert('hex color rejects short values', !isHexColor('#fff'));
  assertEqual('hex to rgb parses channels', hexToRgb('#010203'), { r: 1, g: 2, b: 3 });
  assertEqual('rgb to hex formats channels', rgbToHex(1, 2, 3), '#010203');
  assert('custom colors only override themes when explicitly enabled', !resolveCustomColorsEnabled(null));
  assert('custom colors explicit enable keeps working', resolveCustomColorsEnabled('1'));
  setAppLanguage('en');
  assertEqual('empty math hint translates to English', translate('emptyMath'), 'Empty math');
  assertEqual('sidebar files label translates to English', translate('sidebarFiles'), 'Files');
  assertEqual('sidebar outline label translates to English', translate('sidebarOutline'), 'Outline');
  setAppLanguage('zh-CN');
  assertEqual('empty math hint translates to Chinese', translate('emptyMath'), '空公式');
  assertEqual('sidebar files label translates to Chinese', translate('sidebarFiles'), '文件');
  assertEqual('sidebar outline label translates to Chinese', translate('sidebarOutline'), '大纲');

  const baseGradient = { enabled: true, strength: 0.55 };
  const lightGradient = buildThemeGradientStyles(baseGradient, 'light', 'natural');
  const darkGradient = buildThemeGradientStyles(baseGradient, 'dark', 'natural');
  const cyberpunkLight = buildThemeGradientStyles(baseGradient, 'light', 'cyberpunk');
  const cyberpunkDark = buildThemeGradientStyles(baseGradient, 'dark', 'cyberpunk');
  assert(
    'dark gradients use lower opacity than light gradients',
    Boolean(
      lightGradient &&
        darkGradient &&
        darkGradient.surface.includes('--ui-accent) 6%') &&
        lightGradient.surface.includes('--ui-accent) 14%'),
    ),
    JSON.stringify({ lightGradient, darkGradient }),
  );
  assert(
    'cyberpunk gradients are more pronounced than natural gradients',
    Boolean(
      cyberpunkLight &&
        cyberpunkDark &&
        lightGradient &&
        cyberpunkLight.surface.includes('--ui-accent) 24%') &&
        cyberpunkDark.surface.includes('--ui-accent) 17%') &&
        cyberpunkLight.surface.includes('var(--ui-text)'),
    ),
    JSON.stringify({ cyberpunkLight, cyberpunkDark }),
  );
  assert(
    'disabled gradients return null',
    buildThemeGradientStyles({ enabled: false, strength: 0.55 }, 'dark', 'cyberpunk') === null,
  );
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
  {
    const mathGap = markdownToExportHtmlFragment({
      markdown: '$$\nx\n$$\n\nabc\n',
      title: 't',
    });
    assert('export structural math separator has no spacer', !mathGap.includes('data-trailing-blank-lines'), mathGap);
    const mathBlank = markdownToExportHtmlFragment({
      markdown: '$$\nx\n$$\n\n\nabc\n',
      title: 't',
    });
    assert(
      'export one explicit math blank line is marked',
      mathBlank.includes('data-trailing-blank-lines="1"') &&
        mathBlank.includes('--marivell-math-blank-lines:1'),
      mathBlank,
    );
  }
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
  const codeParent = { type: { name: 'codeBlock' }, content: { size: 12 } };
  const codeTextSelection = {
    empty: false,
    $from: {
      parent: codeParent,
      parentOffset: 0,
    },
    $to: {
      parent: codeParent,
      parentOffset: 12,
    },
  } as Parameters<typeof isPartialInsideWrapperParent>[0];
  assert(
    'full inner code text selection stays raw',
    isPartialInsideWrapperParent(codeTextSelection),
  );
  assert(
    'full inner code text selection is not a whole-node selection',
    !isWholeNodeSelection(codeTextSelection),
  );

  const mathParent = { type: { name: 'inlineMath' }, content: { size: 6 } };
  const mathTextSelection = {
    empty: false,
    $from: {
      parent: mathParent,
      parentOffset: 0,
    },
    $to: {
      parent: mathParent,
      parentOffset: 6,
    },
  } as Parameters<typeof isPartialInsideWrapperParent>[0];
  assert(
    'full inner math text selection stays raw',
    isPartialInsideWrapperParent(mathTextSelection),
  );
  assert(
    'full inner math text selection is not a whole-node selection',
    !isWholeNodeSelection(mathTextSelection),
  );

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

  // Whole inline math (closed slice) keeps delimiter wrappers.
  const wholeMath = {
    content: {
      toJSON: () => [
        {
          type: 'inlineMath',
          attrs: { display: 'no', openDelim: '$', closeDelim: '$' },
          content: [{ type: 'text', text: 'a^2' }],
        },
      ],
    },
    openStart: 0,
    openEnd: 0,
  };
  const wholeMathText = serializeSliceForClipboard(wholeMath);
  assert(
    'whole math keeps wrappers',
    wholeMathText.includes('$') && wholeMathText.includes('a^2'),
    `got: ${JSON.stringify(wholeMathText)}`,
  );

  // Partial/open math slice stays raw (no wrappers) — interior edit copy.
  const partialMath = {
    content: {
      toJSON: () => [
        {
          type: 'inlineMath',
          attrs: { display: 'no', openDelim: '$', closeDelim: '$' },
          content: [{ type: 'text', text: 'a^2' }],
        },
      ],
    },
    openStart: 1,
    openEnd: 1,
  };
  const partialMathText = serializeSliceForClipboard(partialMath);
  assertEqual('partial math is raw latex', partialMathText, 'a^2');

  // Whole code block keeps fences.
  const wholeCode = {
    content: {
      toJSON: () => [
        {
          type: 'codeBlock',
          attrs: { language: 'js' },
          content: [{ type: 'text', text: 'x = 1' }],
        },
      ],
    },
    openStart: 0,
    openEnd: 0,
  };
  const wholeCodeText = serializeSliceForClipboard(wholeCode);
  assert(
    'whole code keeps fence markers',
    wholeCodeText.includes('```') && wholeCodeText.includes('x = 1'),
    `got: ${JSON.stringify(wholeCodeText)}`,
  );
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

section('selection marker cleanup');

{
  const noMarkers = (value: unknown) => !JSON.stringify(value).includes('MDEDITORSELECTION');

  const markedImage = `![Dora MDEDITORSELECTIONSTARTTOKEN MDEDITORSELECTIONENDTOKEN](../images/dora.png "Dora")`;
  const cleanedImageJson = cleanSelectionMarkersFromJsonContent(parseMarkdown(markedImage));
  const cleanedImageText = JSON.stringify(cleanedImageJson);
  assert(
    'image attrs selection markers removed',
    noMarkers(cleanedImageJson) && cleanedImageText.includes('"alt":"Dora"'),
  );
  const cleanedImageMarkdown = serializeMarkdown(cleanedImageJson);
  assert(
    'cleaned image markdown is stable',
    noMarkers(cleanedImageMarkdown) &&
      cleanedImageMarkdown.includes('![Dora](../images/dora.png'),
  );

  const markedLink = `[text](MDEDITORSELECTIONSTARTTOKENhttps://example.comMDEDITORSELECTIONENDTOKEN "MDEDITORSELECTIONSTARTTOKENTitleMDEDITORSELECTIONENDTOKEN")`;
  const cleanedLinkJson = cleanSelectionMarkersFromJsonContent(parseMarkdown(markedLink));
  const cleanedLinkText = JSON.stringify(cleanedLinkJson);
  assert(
    'link href/title selection markers removed',
    noMarkers(cleanedLinkJson) &&
      cleanedLinkText.includes('"href":"https://example.com"') &&
      cleanedLinkText.includes('"title":"Title"'),
  );

  const markedHtml = `<div class="MDEDITORSELECTIONSTARTTOKENcardMDEDITORSELECTIONENDTOKEN">x</div>`;
  const cleanedHtmlJson = cleanSelectionMarkersFromJsonContent(parseMarkdown(markedHtml));
  assert(
    'html block attribute markers removed',
    noMarkers(cleanedHtmlJson) && JSON.stringify(cleanedHtmlJson).includes('class=\\"card\\"'),
  );

  const markedCode = '```js\nconst x = MDEDITORSELECTIONSTARTTOKEN1MDEDITORSELECTIONENDTOKEN;\n```\n';
  const cleanedCodeJson = cleanSelectionMarkersFromJsonContent(parseMarkdown(markedCode));
  assert(
    'code block text markers removed',
    noMarkers(cleanedCodeJson) && JSON.stringify(cleanedCodeJson).includes('const x = 1;'),
  );

  const markedMath = '$MDEDITORSELECTIONSTARTTOKENx^2MDEDITORSELECTIONENDTOKEN$';
  const cleanedMathJson = cleanSelectionMarkersFromJsonContent(parseMarkdown(markedMath));
  assert(
    'math markers removed',
    noMarkers(cleanedMathJson) && JSON.stringify(cleanedMathJson).includes('x^2'),
  );

  const imageMarkdown = '![Dora](../images/dora.png "Dora")';
  let allOffsetsClean = true;
  let firstBadOffset = '';
  for (let start = 0; start <= imageMarkdown.length; start += 1) {
    for (let end = start; end <= imageMarkdown.length; end += 1) {
      const marked = `${imageMarkdown.slice(0, start)}MDEDITORSELECTIONSTARTTOKEN${imageMarkdown.slice(
        start,
        end,
      )}MDEDITORSELECTIONENDTOKEN${imageMarkdown.slice(end)}`;
      const cleaned = cleanSelectionMarkersFromJsonContent(parseMarkdown(marked));
      const cleanedMarkdown = serializeMarkdown(cleaned);
      if (
        !noMarkers(cleaned) ||
        !noMarkers(cleanedMarkdown) ||
        serializeMarkdown(parseMarkdown(cleanedMarkdown)) !== cleanedMarkdown
      ) {
        allOffsetsClean = false;
        firstBadOffset = `${start}:${end} → ${cleanedMarkdown}`;
        break;
      }
    }
    if (!allOffsetsClean) {
      break;
    }
  }
  assert('all image selection offsets clean after source/preview switch', allOffsetsClean, firstBadOffset);
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
