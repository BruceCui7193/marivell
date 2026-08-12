export type U2BatchRenderKind = 'canvas-raster' | 'bitmap-data-url';

let u2EnabledCache: boolean | null = null;

export function isU2Enabled(): boolean {
  if (u2EnabledCache === null) {
    const markdownEditor = (window as unknown as {
      markdownEditor?: { getUltimateU2Enabled?: () => boolean };
    }).markdownEditor;
    u2EnabledCache = markdownEditor?.getUltimateU2Enabled?.() === true;
  }
  return u2EnabledCache;
}

export function resetU2EnabledCacheForTest(): void {
  u2EnabledCache = null;
}

export function setU2EnabledForTest(enabled: boolean): void {
  u2EnabledCache = enabled;
}

export interface SingleNodeFormulaCandidate {
  key: string;
  latex: string;
  display: 'yes' | 'no';
  html: string;
  dpr1DataUrl?: string;
  dpr2DataUrl?: string;
  svgDataUrl?: string;
  cssWidth?: number;
  cssHeight?: number;
  decodedPngBytes?: number;
  svgBytes?: number;
}

export type SingleNodeFormulaRenderKind =
  | 'canvas-raster'
  | 'bitmap-data-url'
  | 'svg-viewbox';

export function serializeSingleNodeFormula(source: {
  latex: string;
  display: 'yes' | 'no';
}): string {
  const value = source.latex.trim();
  return source.display === 'yes' ? `$$\n${value}\n$$` : `$${value}$`;
}

export interface SingleNodeFormulaMatch {
  index: number;
  start: number;
  end: number;
  latex: string;
}

export interface SingleNodeSearchOptions {
  caseSensitive?: boolean;
}

function normalizeSearchValue(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLocaleLowerCase();
}

export function findSingleNodeFormulaByLatex(
  candidates: Array<Pick<SingleNodeFormulaCandidate, 'latex' | 'display'>>,
  query: string,
  options: SingleNodeSearchOptions = {},
): SingleNodeFormulaMatch[] {
  if (!query) {
    return [];
  }

  const needle = normalizeSearchValue(query, Boolean(options.caseSensitive));
  const matches: SingleNodeFormulaMatch[] = [];
  let sourceCursor = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    const source = serializeSingleNodeFormula(candidate);
    const haystack = normalizeSearchValue(source, Boolean(options.caseSensitive));
    let cursor = 0;
    while (cursor <= haystack.length - needle.length) {
      const start = haystack.indexOf(needle, cursor);
      if (start === -1) {
        break;
      }
      matches.push({
        index,
        start: sourceCursor + start,
        end: sourceCursor + start + needle.length,
        latex: candidate.latex,
      });
      cursor = start + Math.max(needle.length, 1);
    }
    sourceCursor += source.length + 1;
  }

  return matches;
}

export function restoreSingleNodeFormulaHtml(
  candidate: SingleNodeFormulaCandidate,
): { html: string; kind: 'katex-html' } {
  return { html: candidate.html, kind: 'katex-html' };
}

export interface SingleNodeExportOptions {
  dpr?: 1 | 1.5 | 2;
  preferHighResolutionBitmap?: boolean;
}

export interface SingleNodeExportPayload {
  key: string;
  latex: string;
  display: 'yes' | 'no';
  dpr: 1 | 1.5 | 2;
  dataUrl: string | null;
  html: string;
  width: number | null;
  height: number | null;
}

export function createSingleNodeExportPayload(
  candidate: SingleNodeFormulaCandidate,
  options: SingleNodeExportOptions = {},
): SingleNodeExportPayload {
  const dpr = options.dpr ?? 2;
  const dataUrl =
    dpr === 1
      ? candidate.dpr1DataUrl ?? null
      : dpr === 1.5
        ? candidate.dpr1DataUrl ?? candidate.dpr2DataUrl ?? null
        : candidate.dpr2DataUrl ?? candidate.svgDataUrl ?? null;
  const width = candidate.cssWidth ?? null;
  const height = candidate.cssHeight ?? null;

  if (options.preferHighResolutionBitmap !== false && dataUrl !== null) {
    return {
      key: candidate.key,
      latex: candidate.latex,
      display: candidate.display,
      dpr,
      dataUrl,
      html: candidate.html,
      width,
      height,
    };
  }

  return {
    key: candidate.key,
    latex: candidate.latex,
    display: candidate.display,
    dpr,
    dataUrl: null,
    html: candidate.html,
    width,
    height,
  };
}

export interface SingleNodeBaselineGeometry {
  widthPx: number;
  heightPx: number;
  baselineOffsetTopPx: number;
  descenderPx: number;
  verticalAlignPx: number;
}

export interface SingleNodeBaselineGeometryInput {
  contentWidthPx: number;
  contentHeightPx: number;
  contentTopPx: number;
  lineBaselineTopPx: number;
  lineBoxTrimPx?: number;
}

/**
 * Converts measured KaTeX geometry into CSS sizing for a single-node raster.
 * lineBoxTrimPx removes KaTeX line-box padding that is not shared by ordinary
 * text, so the raster participates in the surrounding line box with its own
 * width/height + vertical-align instead of reproducing the .katex line box.
 *
 * Let B be the line's alphabetic baseline and T the top of the formula's
 * visual content box. The KaTeX baseline sits B - T below the content top.
 * A replaced single-node element has no internal text baseline, so its CSS
 * baseline is its bottom margin edge. To place its virtual baseline at B:
 *
 *   height = contentHeight - lineBoxTrim
 *   verticalAlign = -(height - (B - T)) = B - T - height
 *
 * The positive value height - (B - T) is the descender below the baseline.
 */
export function computeSingleNodeBaselineGeometry(
  input: SingleNodeBaselineGeometryInput,
): SingleNodeBaselineGeometry {
  const widthPx = Math.max(0, input.contentWidthPx);
  const lineBoxTrimPx = Math.max(0, input.lineBoxTrimPx ?? 0);
  const heightPx = Math.max(0, input.contentHeightPx - lineBoxTrimPx);
  const baselineOffsetTopPx = input.lineBaselineTopPx - input.contentTopPx;
  const descenderPx = heightPx - baselineOffsetTopPx;
  return {
    widthPx,
    heightPx,
    baselineOffsetTopPx,
    descenderPx,
    verticalAlignPx: baselineOffsetTopPx - heightPx,
  };
}

export function applySingleNodeBaselineLayout(
  element: HTMLElement,
  geometry: SingleNodeBaselineGeometry,
  display: 'yes' | 'no',
): void {
  element.style.display = display === 'yes' ? 'block' : 'inline-block';
  element.style.width = `${geometry.widthPx}px`;
  element.style.height = `${geometry.heightPx}px`;
  element.style.overflow = 'visible';
  if (display === 'no') {
    element.style.verticalAlign = `${geometry.verticalAlignPx}px`;
  } else {
    element.style.verticalAlign = 'baseline';
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`failed to load formula raster: ${src.slice(0, 40)}`));
    image.src = src;
  });
}

export async function createSingleNodeFormulaElement(
  kind: U2BatchRenderKind,
  source: {
    latex: string;
    display: 'yes' | 'no';
    html: string;
    dpr2DataUrl?: string;
    dpr1DataUrl?: string;
  },
  geometry: SingleNodeBaselineGeometry,
): Promise<HTMLElement> {
  const raster = source.dpr2DataUrl ?? source.dpr1DataUrl;
  if (!raster) {
    throw new Error(`single-node raster missing for ${kind}`);
  }

  if (kind === 'canvas-raster') {
    const image = await loadImage(raster);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, image.naturalWidth);
    canvas.height = Math.max(1, image.naturalHeight);
    const context = canvas.getContext('2d');
    if (context) {
      context.drawImage(image, 0, 0);
    }
    applySingleNodeBaselineLayout(canvas, geometry, source.display);
    canvas.dataset.u2Latex = source.latex;
    canvas.dataset.u2Display = source.display;
    canvas.dataset.u2KatexHtml = source.html;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `LaTeX: ${source.latex}`);
    return canvas;
  }

  const image = document.createElement('img');
  image.alt = '';
  image.src = raster;
  applySingleNodeBaselineLayout(image, geometry, source.display);
  image.dataset.u2Latex = source.latex;
  image.dataset.u2Display = source.display;
  image.dataset.u2KatexHtml = source.html;
  image.setAttribute('role', 'img');
  image.setAttribute('aria-label', `LaTeX: ${source.latex}`);
  await image.decode();
  return image;
}

export interface SingleNodeBatchTask<T = unknown> {
  key: string;
  priority?: number;
  data?: T;
}

export interface SingleNodeBatchProcessorOptions<T, R> {
  batchSize?: number;
  concurrency?: number;
  maxSwapPerFrame?: number;
  generate: (task: SingleNodeBatchTask<T>) => Promise<R>;
  swap: (result: R, task: SingleNodeBatchTask<T>) => void;
}

export interface SingleNodePercentileSummary {
  count: number;
  min: number;
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

export interface SingleNodeBatchStats {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  skipped: number;
  batchCount: number;
  batchSize: number;
  concurrency: number;
  maxSwapPerFrame: number;
  generationMs: SingleNodePercentileSummary;
  swapMs: SingleNodePercentileSummary;
  batchMs: SingleNodePercentileSummary;
  maxSwapsInFrameObserved: number;
}

function percentileSummary(values: number[]): SingleNodePercentileSummary {
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
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    avg: sorted.reduce((total, value) => total + value, 0) / sorted.length,
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

interface InternalBatchItem<T, R> {
  task: SingleNodeBatchTask<T>;
  result: R | null;
  error: unknown;
}

/**
 * Single-queue, bounded-concurrency prototype for U2.2. It intentionally uses
 * one pump timer per batch instead of one timer per formula, and swaps at most
 * maxSwapPerFrame elements per animation frame.
 */
export class SingleNodeBatchProcessor<T, R> {
  private readonly options: SingleNodeBatchProcessorOptions<T, R>;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly maxSwapPerFrame: number;
  private readonly queue: Array<SingleNodeBatchTask<T>> = [];
  private readonly items: InternalBatchItem<T, R>[] = [];
  private readonly generationTimes: number[] = [];
  private readonly swapTimes: number[] = [];
  private readonly batchTimes: number[] = [];
  private batchCount = 0;
  private completed = 0;
  private failed = 0;
  private cancelled = 0;
  private skipped = 0;
  private active = 0;
  private swapsInFrame = 0;
  private maxSwapsInFrameObserved = 0;
  private pumpScheduled = false;
  private pumping = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushResolvers: Array<() => void> = [];
  private readonly cancelledKeys = new Set<string>();

  constructor(options: SingleNodeBatchProcessorOptions<T, R>) {
    const normalized = {
      batchSize: 12,
      concurrency: 8,
      maxSwapPerFrame: 3,
      ...options,
    };
    this.batchSize = normalized.batchSize;
    this.concurrency = normalized.concurrency;
    this.maxSwapPerFrame = normalized.maxSwapPerFrame;
    this.options = options;
  }

  enqueue(tasks: SingleNodeBatchTask<T>[]): void {
    for (const task of tasks) {
      this.cancelledKeys.delete(task.key);
      this.queue.push(task);
    }
    this.queue.sort((left, right) => (left.priority ?? 1) - (right.priority ?? 1));
    this.schedulePump();
  }

  has(key: string): boolean {
    return this.queue.some((task) => task.key === key) || this.cancelledKeys.has(key);
  }

  size(): number {
    return this.queue.length + this.active;
  }

  isCancelled(key: string): boolean {
    return this.cancelledKeys.has(key);
  }

  cancel(key: string): void {
    if (this.cancelledKeys.has(key)) {
      return;
    }
    this.cancelledKeys.add(key);
    this.cancelled += 1;
    const nextQueue = this.queue.filter((task) => task.key !== key);
    this.queue.length = 0;
    this.queue.push(...nextQueue);
  }

  cancelAll(): void {
    for (const task of this.queue) {
      if (!this.cancelledKeys.has(task.key)) {
        this.cancelledKeys.add(task.key);
        this.cancelled += 1;
      }
    }
    this.queue.length = 0;
    for (const item of this.items) {
      if (!this.cancelledKeys.has(item.task.key)) {
        this.cancelledKeys.add(item.task.key);
        this.cancelled += 1;
      }
    }
  }

  async flush(): Promise<SingleNodeBatchStats> {
    this.schedulePump();
    if (this.queue.length === 0 && this.active === 0 && !this.pumping) {
      return this.getStats();
    }
    await new Promise<void>((resolve) => {
      this.flushResolvers.push(resolve);
    });
    return this.getStats();
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.pumping) {
      return;
    }
    this.pumpScheduled = true;
    this.timer = setTimeout(() => {
      this.pumpScheduled = false;
      this.timer = null;
      void this.pump();
    }, 0);
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.batchSize);
        const start = performance.now();
        await this.runBatch(batch);
        this.batchTimes.push(performance.now() - start);
        this.batchCount += 1;
      }
    } finally {
      this.pumping = false;
      const resolvers = this.flushResolvers.splice(0);
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  private async runBatch(batch: SingleNodeBatchTask<T>[]): Promise<void> {
    const pending = [...batch];
    const workers = Array.from(
      { length: Math.min(this.concurrency, pending.length) },
      async () => {
        while (pending.length > 0) {
          const task = pending.shift();
          if (!task) {
            break;
          }
          this.active += 1;
          const item: InternalBatchItem<T, R> = { task, result: null, error: null };
          this.items.push(item);
          const generateStart = performance.now();
          try {
            const result = await this.options.generate(task);
            this.generationTimes.push(performance.now() - generateStart);
            item.result = result;
            if (this.isCancelled(task.key)) {
              this.skipped += 1;
              continue;
            }
            const swapStart = performance.now();
            await this.swapWithFrameLimit(result, task);
            this.swapTimes.push(performance.now() - swapStart);
            this.completed += 1;
          } catch (error) {
            item.error = error;
            this.failed += 1;
          } finally {
            this.active -= 1;
          }
        }
      },
    );
    await Promise.all(workers);
  }

  private async swapWithFrameLimit(result: R, task: SingleNodeBatchTask<T>): Promise<void> {
    if (this.swapsInFrame >= this.maxSwapPerFrame) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      this.swapsInFrame = 0;
    }
    this.swapsInFrame += 1;
    this.maxSwapsInFrameObserved = Math.max(
      this.maxSwapsInFrameObserved,
      this.swapsInFrame,
    );
    this.options.swap(result, task);
  }

  private getStats(): SingleNodeBatchStats {
    return {
      total: this.items.length,
      completed: this.completed,
      failed: this.failed,
      cancelled: this.cancelled,
      skipped: this.skipped,
      batchCount: this.batchCount,
      batchSize: this.batchSize,
      concurrency: this.concurrency,
      maxSwapPerFrame: this.maxSwapPerFrame,
      generationMs: percentileSummary(this.generationTimes),
      swapMs: percentileSummary(this.swapTimes),
      batchMs: percentileSummary(this.batchTimes),
      maxSwapsInFrameObserved: this.maxSwapsInFrameObserved,
    };
  }
}

export function createSingleNodeBatchProcessor<T, R>(
  options: SingleNodeBatchProcessorOptions<T, R>,
): SingleNodeBatchProcessor<T, R> {
  return new SingleNodeBatchProcessor(options);
}
