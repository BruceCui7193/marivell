import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { parseMarkdown } from '../../src/renderer/editor/markdown.ts';
import {
  collectFormulaIndex,
  renderFormulaChunk,
} from '../../src/renderer/editor/markdown.worker.ts';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronBin = path.join(projectRoot, 'node_modules/.bin/electron');
const electronViteBin = path.join(projectRoot, 'node_modules/.bin/electron-vite');

export const DEFAULT_SOURCE_MARKDOWN =
  '/home/crh/下载/barfoot_ser24/barfoot_ser24.md';

export interface DomInjectionPercentile {
  count: number;
  min: number;
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

export interface DomInjectionSample {
  ms: number;
  heapDelta: number;
  styleMutations: number;
  classMutations: number;
  childListMutations: number;
  domMutations: number;
  addedNodes: number;
  removedNodes: number;
  insertedNodes: number;
  longTasks: number;
  longTaskMs: number;
  perRoundMs?: number[];
}

export interface DomInjectionScenarioResult {
  samples: DomInjectionSample[];
  ms: DomInjectionPercentile;
  heapDelta: DomInjectionPercentile;
  styleMutations: DomInjectionPercentile;
  domMutations: DomInjectionPercentile;
  longTaskCount: number;
  longTaskMs: number;
}

export interface DomInjectionMethodResult {
  method: string;
  supported: boolean;
  skipReason: string | null;
  oneShot: DomInjectionScenarioResult;
  reactivation: DomInjectionScenarioResult;
}

export interface DomInjectionPageResult {
  environment: {
    userAgent: string;
    title: string;
    formulaHtmlBytes: number;
    iframeMethodCount: number;
    heapApi: {
      available: boolean;
      usedJSHeapSizeBefore: number | null;
      usedJSHeapSizeAfter: number | null;
      delta: number | null;
    };
  };
  methods: DomInjectionMethodResult[];
}

export interface DomInjectionCorpusEntry {
  latex: string;
  display: 'yes' | 'no';
  htmlBytes: number;
}

export interface DomInjectionCorpus {
  sourceBytes: number;
  totalUnique: number;
  selected: number;
  inline: number;
  block: number;
  quartileCounts: number[];
  sample: DomInjectionCorpusEntry[];
}

export interface DomInjectionE2EResult {
  sourceMarkdown: string;
  corpus: DomInjectionCorpus;
  buildMs: number;
  launchMs: number;
  readyMs: number;
  page: DomInjectionPageResult;
}

interface ElectronHandle {
  child: ReturnType<typeof spawn>;
  browser: Browser;
  page: Page;
  port: number;
  spawnedAt: number;
}

interface DomInjectionPoCInput {
  formulaHtml: string[];
  formulaCount: number;
  warmupRounds: number;
  measurementRounds: number;
  reactivationCycles: number;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentileSummary(values: number[]): DomInjectionPercentile {
  if (values.length === 0) {
    return { count: 0, min: 0, avg: 0, p50: 0, p95: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (ratio: number): number => {
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.floor((sorted.length - 1) * ratio)),
    );
    return sorted[index] ?? 0;
  };
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    avg: sum / sorted.length,
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function summarizeSampleField(
  samples: DomInjectionSample[],
  field: 'ms' | 'heapDelta' | 'styleMutations' | 'domMutations',
): DomInjectionPercentile {
  return percentileSummary(samples.map((sample) => sample[field]));
}

async function buildRenderer(outDir: string): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  await execFileAsync(
    electronViteBin,
    ['build', '--outDir', outDir, '--logLevel', 'warn'],
    { cwd: projectRoot, env: { ...process.env } },
  );
  const nodeModules = path.join(outDir, 'node_modules');
  if (!fs.existsSync(nodeModules)) {
    fs.symlinkSync(path.join(projectRoot, 'node_modules'), nodeModules, 'dir');
  }
}

async function connectToElectron(port: number, timeoutMs: number): Promise<Browser> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await wait(250);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('failed to connect to Electron');
}

async function launchElectron(
  outDir: string,
  filePath: string,
  port: number,
  profile: string,
): Promise<ElectronHandle> {
  const spawnedAt = Date.now();
  const child = spawn(
    electronBin,
    [
      path.join(outDir, 'main', 'index.js'),
      '--no-sandbox',
      '--disable-gpu',
      '--enable-precise-memory-info',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      filePath,
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, MARIVELL_BENCHMARK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  );

  const browser = await connectToElectron(port, 30_000);
  const context = browser.contexts()[0];
  const page = context?.pages()[0];
  if (!page) {
    throw new Error('Electron page was not created');
  }
  await page.waitForLoadState('domcontentloaded');
  return { child, browser, page, port, spawnedAt };
}

async function waitForVisualReady(
  page: Page,
  expectedNodeSize: number,
  deadlineMs: number,
): Promise<{ waitMs: number; timedOut: boolean }> {
  return page.evaluate(
    async ({ expectedSize, deadlineMs }) => {
      const start = Date.now();
      const deadline = start + deadlineMs;
      while (Date.now() < deadline) {
        const loading = document.querySelector('.editor-loading');
        const surface = document.querySelector('.editor-surface');
        const frame = document.querySelector('.editor-frame');
        const editor = window.__marivellEditor as
          | { state?: { doc?: { nodeSize?: number } } }
          | undefined;
        const nodeReady = Boolean(
          editor?.state?.doc && editor.state.doc.nodeSize > expectedSize,
        );
        const textReady = Boolean(
          surface && surface.innerText.length > Math.min(expectedSize, 10_000),
        );
        if (!loading && surface && frame && (nodeReady || textReady)) {
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return { waitMs: Date.now() - start, timedOut: false };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return { waitMs: Date.now() - start, timedOut: true };
    },
    { expectedSize: expectedNodeSize, deadlineMs },
  );
}

function buildFormulaCorpus(
  sourceMarkdownPath: string,
  selectedCount: number,
): DomInjectionCorpus & { formulaHtml: string[] } {
  const sourceBytes = fs.statSync(sourceMarkdownPath).size;
  const markdown = fs.readFileSync(sourceMarkdownPath, 'utf8');
  const entries = collectFormulaIndex(parseMarkdown(markdown));
  const rendered = renderFormulaChunk(entries);
  const sized = entries
    .map((entry) => ({
      entry,
      html: rendered[entry.key] ?? '',
      htmlBytes: (rendered[entry.key] ?? '').length,
    }))
    .filter((item) => item.htmlBytes > 0);

  const pickFromBucket = (
    bucket: Array<typeof sized[number]>,
    needed: number,
  ): Array<typeof sized[number]> => {
    if (bucket.length === 0) {
      return [];
    }
    const result: Array<typeof sized[number]> = [];
    const step = bucket.length / needed;
    for (let index = 0; index < needed; index += 1) {
      const picked = bucket[Math.min(bucket.length - 1, Math.floor(index * step))];
      if (picked) {
        result.push(picked);
      }
    }
    return result;
  };

  const selectedByDisplay: Array<typeof sized[number]> = [];
  const quartileCounts: number[] = [0, 0, 0, 0];
  for (const display of ['no', 'yes'] as const) {
    const byDisplay = sized
      .filter((item) => item.entry.display === display)
      .sort((a, b) => a.htmlBytes - b.htmlBytes);
    const perDisplay = Math.ceil(selectedCount / 2);
    const bucketSize = Math.max(1, Math.ceil(byDisplay.length / 4));
    for (let quartile = 0; quartile < 4; quartile += 1) {
      const start = quartile * bucketSize;
      const bucket = byDisplay.slice(start, start + bucketSize);
      const needed = Math.ceil(perDisplay / 4);
      const picked = pickFromBucket(bucket, needed);
      selectedByDisplay.push(...picked);
      quartileCounts[quartile] += picked.length;
    }
  }

  const selected = selectedByDisplay.slice(0, selectedCount);
  const unique = new Set(selected.map((item) => item.entry.key));
  if (selected.length !== selectedCount || unique.size !== selected.length) {
    throw new Error(
      `formula corpus selection failed: selected=${selected.length} unique=${unique.size}`,
    );
  }

  return {
    sourceBytes,
    totalUnique: sized.length,
    selected: selected.length,
    inline: selected.filter((item) => item.entry.display === 'no').length,
    block: selected.filter((item) => item.entry.display === 'yes').length,
    quartileCounts,
    sample: selected.map((item) => ({
      latex: item.entry.latex,
      display: item.entry.display,
      htmlBytes: item.htmlBytes,
    })),
    formulaHtml: selected.map((item) => item.html),
  };
}

function emptyScenarioResult(): DomInjectionScenarioResult {
  return {
    samples: [],
    ms: percentileSummary([]),
    heapDelta: percentileSummary([]),
    styleMutations: percentileSummary([]),
    domMutations: percentileSummary([]),
    longTaskCount: 0,
    longTaskMs: 0,
  };
}

export function runDomInjectionPoCInPage(
  input: DomInjectionPoCInput,
): Promise<DomInjectionPageResult> {
  const methods = [
    'innerHTML',
    'insert-adjacent-html',
    'template-clone',
    'range-contextual-fragment',
    'json-create-element',
    'json-create-element-fragment',
    'set-html-unsafe',
  ];

  interface JsonNode {
    type: 'text' | 'element';
    tag?: string;
    attrs?: Array<{ name: string; value: string }>;
    text?: string;
    children?: JsonNode[];
  }

  interface MethodContext {
    method: string;
    iframe: HTMLIFrameElement;
    doc: Document;
    container: HTMLDivElement;
    supported: boolean;
    skipReason: string;
    combinedHtml: string;
    templates: HTMLTemplateElement[] | null;
    range: Range | null;
    jsonTree: JsonNode[] | null;
  }

  interface SampleWindow {
    method: string;
    scenario: 'one-shot' | 'reactivation';
    metrics: DomInjectionSample;
    start: number;
    end: number;
  }

  const percentileSummary = (values: number[]): DomInjectionPercentile => {
    if (values.length === 0) {
      return { count: 0, min: 0, avg: 0, p50: 0, p95: 0, max: 0 };
    }
    const sorted = [...values].sort((a, b) => a - b);
    const pick = (ratio: number): number => {
      const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.floor((sorted.length - 1) * ratio)),
      );
      return sorted[index] ?? 0;
    };
    const sum = sorted.reduce((total, value) => total + value, 0);
    return {
      count: sorted.length,
      min: sorted[0] ?? 0,
      avg: sum / sorted.length,
      p50: pick(0.5),
      p95: pick(0.95),
      max: sorted[sorted.length - 1] ?? 0,
    };
  };

  const summarizeSampleField = (
    samples: DomInjectionSample[],
    field: 'ms' | 'heapDelta' | 'styleMutations' | 'domMutations',
  ): DomInjectionPercentile => percentileSummary(samples.map((sample) => sample[field]));

  const nodeListToJson = (nodes: NodeList | ArrayLike<Node>): JsonNode[] => {
    const result: JsonNode[] = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (!node) {
        continue;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        result.push({ type: 'text', text: node.textContent ?? '' });
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }
      const element = node as Element;
      const attrs: Array<{ name: string; value: string }> = [];
      for (let attrIndex = 0; attrIndex < element.attributes.length; attrIndex += 1) {
        const attr = element.attributes[attrIndex];
        if (attr) {
          attrs.push({ name: attr.name, value: attr.value });
        }
      }
      result.push({
        type: 'element',
        tag: element.tagName,
        attrs,
        children: nodeListToJson(element.childNodes),
      });
    }
    return result;
  };

  const jsonToElement = (doc: Document, json: JsonNode): Node => {
    if (json.type === 'text') {
      return doc.createTextNode(json.text ?? '');
    }
    const element = doc.createElement(json.tag ?? 'div');
    for (const attr of json.attrs ?? []) {
      element.setAttribute(attr.name, attr.value);
    }
    for (const child of json.children ?? []) {
      element.appendChild(jsonToElement(doc, child));
    }
    return element;
  };

  const createHiddenIframe = (
    ownerDocument: Document,
    method: string,
  ): Promise<HTMLIFrameElement> =>
    new Promise((resolve, reject) => {
      const iframe = ownerDocument.createElement('iframe');
      iframe.setAttribute('data-method', method);
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.cssText =
        'position:absolute;left:-10000px;top:0;width:800px;height:1200px;visibility:hidden;';
      iframe.srcdoc = '<!doctype html><html><head></head><body></body></html>';
      iframe.addEventListener('load', () => resolve(iframe), { once: true });
      iframe.addEventListener(
        'error',
        () => reject(new Error(`failed to load method iframe: ${method}`)),
        { once: true },
      );
      ownerDocument.body.appendChild(iframe);
    });

  const createMethodContext = async (
    method: string,
  ): Promise<MethodContext> => {
    const iframe = await createHiddenIframe(document, method);
    const doc = iframe.contentDocument;
    if (!doc || !doc.body) {
      throw new Error(`method iframe has no document: ${method}`);
    }
    const container = doc.createElement('div');
    container.setAttribute('data-formula-host', 'true');
    doc.body.appendChild(container);
    const combinedHtml = input.formulaHtml.join('');
    let templates: HTMLTemplateElement[] | null = null;
    let range: Range | null = null;
    let jsonTree: JsonNode[] | null = null;
    let supported = true;
    let skipReason = '';

    if (method === 'template-clone') {
      templates = input.formulaHtml.map((html) => {
        const item = doc.createElement('template');
        item.innerHTML = html;
        return item;
      });
    } else if (method === 'range-contextual-fragment') {
      range = doc.createRange();
      range.selectNodeContents(container);
    } else if (method === 'json-create-element' || method === 'json-create-element-fragment') {
      const parserTemplate = doc.createElement('template');
      parserTemplate.innerHTML = combinedHtml;
      jsonTree = nodeListToJson(parserTemplate.content.childNodes);
    } else if (method === 'set-html-unsafe') {
      if (
        typeof (
          container as HTMLDivElement & { setHTMLUnsafe?: (html: string) => void }
        ).setHTMLUnsafe !== 'function'
      ) {
        supported = false;
        skipReason = 'setHTMLUnsafe is not available in this Chromium version';
      }
    }

    return {
      method,
      iframe,
      doc,
      container,
      supported,
      skipReason,
      combinedHtml,
      templates,
      range,
      jsonTree,
    };
  };

  const injectIntoContainer = (context: MethodContext): void => {
    const container = context.container;
    if (context.method === 'innerHTML') {
      container.innerHTML = context.combinedHtml;
      return;
    }
    if (context.method === 'insert-adjacent-html') {
      container.insertAdjacentHTML('beforeend', context.combinedHtml);
      return;
    }
    if (context.method === 'template-clone') {
      if (context.templates) {
        for (const item of context.templates) {
          container.appendChild(item.content.cloneNode(true));
        }
      }
      return;
    }
    if (context.method === 'range-contextual-fragment') {
      if (context.range) {
        const fragment = context.range.createContextualFragment(context.combinedHtml);
        container.appendChild(fragment);
      }
      return;
    }
    if (context.method === 'json-create-element') {
      for (const node of context.jsonTree ?? []) {
        container.appendChild(jsonToElement(context.doc, node));
      }
      return;
    }
    if (context.method === 'json-create-element-fragment') {
      const fragment = context.doc.createDocumentFragment();
      for (const node of context.jsonTree ?? []) {
        fragment.appendChild(jsonToElement(context.doc, node));
      }
      container.appendChild(fragment);
      return;
    }
    if (context.method === 'set-html-unsafe') {
      (
        container as HTMLDivElement & { setHTMLUnsafe: (html: string) => void }
      ).setHTMLUnsafe(context.combinedHtml);
    }
  };

  const countInsertedFormulas = (container: HTMLDivElement): number =>
    container.children.length;

  const buildMetrics = (
    start: number,
    end: number,
    heapBefore: number,
    heapAfter: number,
    records: MutationRecord[],
    insertedNodes: number,
    perRoundMs?: number[],
  ): DomInjectionSample => {
    let styleMutations = 0;
    let classMutations = 0;
    let childListMutations = 0;
    let addedNodes = 0;
    let removedNodes = 0;
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.attributeName === 'style') {
          styleMutations += 1;
        } else {
          classMutations += 1;
        }
      } else if (record.type === 'childList') {
        childListMutations += 1;
        addedNodes += record.addedNodes.length;
        removedNodes += record.removedNodes.length;
      }
    }
    return {
      ms: end - start,
      heapDelta: heapAfter - heapBefore,
      styleMutations,
      classMutations,
      childListMutations,
      domMutations: styleMutations + classMutations + childListMutations,
      addedNodes,
      removedNodes,
      insertedNodes,
      longTasks: 0,
      longTaskMs: 0,
      ...(perRoundMs ? { perRoundMs } : {}),
    };
  };

  const memoryApi = (
    performance as Performance & { memory?: { usedJSHeapSize: number } }
  ).memory;

  const collectMutationRecords = (
    iframeWindow: (Window & {
      __d2MutationRecords?: MutationRecord[];
      __d2MutationObserver?: MutationObserver;
    }) | null,
  ): MutationRecord[] => {
    if (!iframeWindow) {
      return [];
    }
    let pending: MutationRecord[] = [];
    try {
      pending = iframeWindow.__d2MutationObserver?.takeRecords() ?? [];
    } catch {
      pending = [];
    }
    try {
      iframeWindow.__d2MutationObserver?.disconnect();
    } catch {
      // The observer may live in a different realm and reject cross-realm calls.
    }
    return [...(iframeWindow.__d2MutationRecords ?? []), ...pending];
  };

  const runSample = async (
    context: MethodContext,
    scenario: 'one-shot' | 'reactivation',
    sampleWindows: SampleWindow[],
    isWarmup = false,
  ): Promise<DomInjectionSample> => {
    context.container.replaceChildren();
    const iframeWindow = context.iframe.contentWindow as
      | (Window & {
          __d2MutationRecords?: MutationRecord[];
          __d2MutationObserver?: MutationObserver;
        })
      | null;
    try {
      iframeWindow?.eval(`
        (() => {
          const records = [];
          const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) records.push(mutation);
          });
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class']
          });
          window.__d2MutationRecords = records;
          window.__d2MutationObserver = observer;
        })();
      `);
    } catch {
      // CSP can block eval in the iframe; the mutation counters are best-effort.
    }
    const heapBefore = memoryApi?.usedJSHeapSize ?? 0;
    const start = performance.now();
    let insertedNodes = 0;

    if (scenario === 'one-shot') {
      injectIntoContainer(context);
      const end = performance.now();
      insertedNodes = countInsertedFormulas(context.container);
      const heapAfter = memoryApi?.usedJSHeapSize ?? 0;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const records = collectMutationRecords(iframeWindow);
      const metrics = buildMetrics(
        start,
        end,
        heapBefore,
        heapAfter,
        records,
        insertedNodes,
      );
      if (!isWarmup) {
        sampleWindows.push({
          method: context.method,
          scenario,
          metrics,
          start,
          end,
        });
      }
      context.container.replaceChildren();
      return metrics;
    }

    const roundTimes: number[] = [];
    for (let round = 0; round < input.reactivationCycles; round += 1) {
      const roundStart = performance.now();
      injectIntoContainer(context);
      const roundEnd = performance.now();
      insertedNodes += countInsertedFormulas(context.container);
      context.container.replaceChildren();
      roundTimes.push(roundEnd - roundStart);
    }
    const end = performance.now();
    const heapAfter = memoryApi?.usedJSHeapSize ?? 0;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const records = collectMutationRecords(iframeWindow);
    const metrics = buildMetrics(
      start,
      end,
      heapBefore,
      heapAfter,
      records,
      insertedNodes,
      roundTimes,
    );
    if (!isWarmup) {
      sampleWindows.push({ method: context.method, scenario, metrics, start, end });
    }
    return metrics;
  };

  const buildScenarioResult = (
    samples: DomInjectionSample[],
    longTaskWindows: Array<{ start: number; end: number }>,
    longTaskEntries: Array<{ startTime: number; duration: number }>,
  ): DomInjectionScenarioResult => {
    let longTaskCount = 0;
    let longTaskMs = 0;
    for (const window of longTaskWindows) {
      for (const entry of longTaskEntries) {
        if (
          entry.startTime < window.end &&
          entry.startTime + entry.duration > window.start
        ) {
          longTaskCount += 1;
          longTaskMs += entry.duration;
        }
      }
    }
    return {
      samples,
      ms: summarizeSampleField(samples, 'ms'),
      heapDelta: summarizeSampleField(samples, 'heapDelta'),
      styleMutations: summarizeSampleField(samples, 'styleMutations'),
      domMutations: summarizeSampleField(samples, 'domMutations'),
      longTaskCount,
      longTaskMs,
    };
  };

  const main = async (): Promise<DomInjectionPageResult> => {
    const contexts: MethodContext[] = [];
    const sampleWindows: SampleWindow[] = [];
    const longTaskEntries: Array<{ startTime: number; duration: number }> = [];
    const heapBeforeHarness = memoryApi?.usedJSHeapSize ?? null;
    let longTaskObserver: PerformanceObserver | null = null;
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTaskEntries.push({ startTime: entry.startTime, duration: entry.duration });
        }
      });
      longTaskObserver.observe({ type: 'longtask', buffered: true });
    } catch {
      longTaskObserver = null;
    }

    for (const method of methods) {
      contexts.push(await createMethodContext(method));
    }

    const supportedContexts = contexts.filter((context) => context.supported);

    for (const scenario of ['one-shot', 'reactivation'] as const) {
      for (let warm = 0; warm < input.warmupRounds; warm += 1) {
        for (const context of supportedContexts) {
          await runSample(context, scenario, sampleWindows, true);
        }
      }
    }

    const rotated = (round: number): MethodContext[] => {
      const offset = round % supportedContexts.length;
      return [
        ...supportedContexts.slice(offset),
        ...supportedContexts.slice(0, offset),
      ];
    };

    for (let round = 0; round < input.measurementRounds; round += 1) {
      for (const context of rotated(round)) {
        await runSample(context, 'one-shot', sampleWindows);
      }
    }
    for (let round = 0; round < input.measurementRounds; round += 1) {
      for (const context of rotated(round)) {
        await runSample(context, 'reactivation', sampleWindows);
      }
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    longTaskObserver?.disconnect();
    try {
      for (const entry of performance.getEntriesByType('longtask')) {
        longTaskEntries.push({ startTime: entry.startTime, duration: entry.duration });
      }
    } catch {
      // longtask may not be exposed as a performance entry type.
    }

    const methodsResult: DomInjectionMethodResult[] = contexts.map((context) => {
      if (!context.supported) {
        return {
          method: context.method,
          supported: false,
          skipReason: context.skipReason,
          oneShot: emptyScenarioResult(),
          reactivation: emptyScenarioResult(),
        };
      }
      const oneShotSamples = sampleWindows.filter(
        (window) => window.method === context.method && window.scenario === 'one-shot',
      );
      const reactivationSamples = sampleWindows.filter(
        (window) => window.method === context.method && window.scenario === 'reactivation',
      );
      return {
        method: context.method,
        supported: true,
        skipReason: null,
        oneShot: buildScenarioResult(
          oneShotSamples.map((window) => window.metrics),
          oneShotSamples,
          longTaskEntries,
        ),
        reactivation: buildScenarioResult(
          reactivationSamples.map((window) => window.metrics),
          reactivationSamples,
          longTaskEntries,
        ),
      };
    });

    const formulaHtmlBytes = input.formulaHtml.reduce(
      (total, html) => total + html.length,
      0,
    );
    const heapAfterHarness = memoryApi?.usedJSHeapSize ?? null;
    return {
      environment: {
        userAgent: navigator.userAgent,
        title: document.title,
        formulaHtmlBytes,
        iframeMethodCount: contexts.length,
        heapApi: {
          available: memoryApi != null,
          usedJSHeapSizeBefore: heapBeforeHarness,
          usedJSHeapSizeAfter: heapAfterHarness,
          delta:
            heapBeforeHarness !== null && heapAfterHarness !== null
              ? heapAfterHarness - heapBeforeHarness
              : null,
        },
      },
      methods: methodsResult,
    };
  };

  return main();
}

export interface DomInjectionPocOptions {
  sourceMarkdownPath?: string;
  corpusSize?: number;
  warmupRounds?: number;
  measurementRounds?: number;
  reactivationCycles?: number;
  outDir?: string;
  profile?: string;
  port?: number;
  keepTempFiles?: boolean;
}

export async function runDomInjectionPocE2E(
  options: DomInjectionPocOptions = {},
): Promise<DomInjectionE2EResult> {
  const sourceMarkdown =
    options.sourceMarkdownPath ?? process.env.MARIVELL_DOM_POC_SOURCE ?? DEFAULT_SOURCE_MARKDOWN;
  const corpusSize = options.corpusSize ?? 200;
  const warmupRounds = options.warmupRounds ?? 5;
  const measurementRounds = options.measurementRounds ?? 20;
  const reactivationCycles = options.reactivationCycles ?? 10;
  if (corpusSize < 200 || corpusSize % 2 !== 0) {
    throw new Error(`corpusSize must be at least 200 and even: ${corpusSize}`);
  }
  if (measurementRounds < 20 || warmupRounds < 5 || reactivationCycles < 10) {
    throw new Error(
      `protocol too small: warmup=${warmupRounds} measured=${measurementRounds} cycles=${reactivationCycles}`,
    );
  }

  const corpus = buildFormulaCorpus(sourceMarkdown, corpusSize);
  const markdownPath = path.join(os.tmpdir(), `marivell-d2-dom-injection-${process.pid}.md`);
  fs.writeFileSync(
    markdownPath,
    '# D2 DOM injection PoC\n\nSmall placeholder file used only to host the benchmark window.\n',
    'utf8',
  );
  const outDir =
    options.outDir ?? path.join(os.tmpdir(), `marivell-d2-poc-build-${process.pid}`);
  const profile =
    options.profile ?? path.join(os.tmpdir(), `marivell-d2-poc-profile-${process.pid}`);
  const port = options.port ?? 9700 + (process.pid % 200);

  let handle: ElectronHandle | null = null;
  try {
    const buildStart = performance.now();
    await buildRenderer(outDir);
    const buildMs = performance.now() - buildStart;
    handle = await launchElectron(outDir, markdownPath, port, profile);
    const launchMs = Date.now() - handle.spawnedAt;
    const ready = await waitForVisualReady(handle.page, 1, 60_000);
    if (ready.timedOut) {
      throw new Error(`visual editor did not become ready in time: ${ready.waitMs}ms`);
    }
    await handle.page.evaluate(() => {
      const benchmarkWindow = window as unknown as {
        __name?: (fn: unknown) => unknown;
      };
      benchmarkWindow.__name = (fn: unknown): unknown => fn;
    });
    const page = await handle.page.evaluate(
      runDomInjectionPoCInPage,
      {
        formulaHtml: corpus.formulaHtml,
        formulaCount: corpus.selected,
        warmupRounds,
        measurementRounds,
        reactivationCycles,
      } satisfies DomInjectionPoCInput,
    );
    return {
      sourceMarkdown,
      corpus: {
        sourceBytes: corpus.sourceBytes,
        totalUnique: corpus.totalUnique,
        selected: corpus.selected,
        inline: corpus.inline,
        block: corpus.block,
        quartileCounts: corpus.quartileCounts,
        sample: corpus.sample,
      },
      buildMs,
      launchMs,
      readyMs: ready.waitMs,
      page,
    };
  } finally {
    if (handle) {
      if (process.platform !== 'win32') {
        try {
          process.kill(-handle.child.pid, 'SIGKILL');
        } catch {
          // Process group may already be gone.
        }
      }
      handle.child.kill('SIGKILL');
      await handle.browser.close().catch(() => {});
    }
    if (!options.keepTempFiles) {
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.rmSync(profile, { recursive: true, force: true });
        fs.rmSync(markdownPath, { force: true });
      } catch {
        // Cleanup is best-effort.
      }
    }
  }
}

function formatMethodSummary(result: DomInjectionMethodResult): Record<string, unknown> {
  return {
    method: result.method,
    supported: result.supported,
    skipReason: result.skipReason,
    oneShot: {
      ms: result.oneShot.ms,
      heapDelta: result.oneShot.heapDelta,
      styleMutations: result.oneShot.styleMutations,
      domMutations: result.oneShot.domMutations,
      longTasks: result.oneShot.longTaskCount,
      longTaskMs: result.oneShot.longTaskMs,
    },
    reactivation: {
      cyclesPerSample: result.reactivation.samples[0]?.perRoundMs?.length ?? 0,
      ms: result.reactivation.ms,
      heapDelta: result.reactivation.heapDelta,
      styleMutations: result.reactivation.styleMutations,
      domMutations: result.reactivation.domMutations,
      longTasks: result.reactivation.longTaskCount,
      longTaskMs: result.reactivation.longTaskMs,
    },
  };
}

function formatSummary(result: DomInjectionE2EResult): Record<string, unknown> {
  return {
    sourceMarkdown: result.sourceMarkdown,
    corpus: {
      sourceBytes: result.corpus.sourceBytes,
      totalUnique: result.corpus.totalUnique,
      selected: result.corpus.selected,
      inline: result.corpus.inline,
      block: result.corpus.block,
      quartileCounts: result.corpus.quartileCounts,
    },
    buildMs: Math.round(result.buildMs * 10) / 10,
    launchMs: Math.round(result.launchMs * 10) / 10,
    readyMs: Math.round(result.readyMs * 10) / 10,
    environment: result.page.environment,
    methods: result.page.methods.map(formatMethodSummary),
  };
}

async function main(): Promise<void> {
  const sourceArg = process.argv[2];
  const sourceMarkdown =
    sourceArg && sourceArg !== '--default' ? path.resolve(sourceArg) : undefined;
  const result = await runDomInjectionPocE2E({ sourceMarkdownPath: sourceMarkdown });
  const rawPath = path.join(os.tmpdir(), `marivell-d2-dom-injection-${Date.now()}.json`);
  fs.writeFileSync(rawPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(formatSummary(result), null, 2));
  console.log(`\nSaved raw D2 PoC JSON to ${rawPath}`);
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
