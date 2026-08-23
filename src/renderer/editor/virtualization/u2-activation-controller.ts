import {
  createSingleNodeBatchProcessor,
  createSingleNodeFormulaElement,
  isU2Enabled,
  type SingleNodeBatchProcessor,
  type SingleNodeBaselineGeometry,
  type U2BatchRenderKind,
} from './formula-single-node';

export interface U2SingleNodeSwapRequest {
  id: string;
  latex: string;
  display: 'yes' | 'no';
  html: string;
  preview: HTMLElement;
  wrapper: HTMLElement;
  priority: number;
  isCurrent: () => boolean;
  restore: () => void;
  onSwapped?: (element: HTMLElement) => void;
}

export interface U2ActivationPercentile {
  count: number;
  min: number;
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

export interface U2ActivationMetrics {
  enabled: boolean;
  requested: number;
  completed: number;
  cancelled: number;
  failed: number;
  pending: number;
  swapped: number;
  queueDepth: number;
  maxQueueDepth: number;
  singleNodeDomCount: number;
  swapReadyMs: U2ActivationPercentile;
  lastError: string | null;
}

interface SwapTiming {
  id: string;
  startedAt: number;
}

const BATCH_SIZE = 12;
const CONCURRENCY = 8;
const MAX_SWAP_PER_FRAME = 3;

const pendingIds = new Set<string>();
const swappedIds = new Set<string>();
const requests = new Map<string, U2SingleNodeSwapRequest>();
const swapTimings = new Map<string, SwapTiming>();
const swapReadyValues: number[] = [];
let requestedCount = 0;
let completedCount = 0;
let cancelledCount = 0;
let failedCount = 0;
let maxQueueDepth = 0;
let lastError: string | null = null;

function percentile(values: number[]): U2ActivationPercentile {
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

function measureContentBounds(root: HTMLElement): {
  width: number;
  height: number;
} {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  const walk = (element: Element): void => {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    for (let index = 0; index < element.children.length; index += 1) {
      const child = element.children[index];
      if (child) {
        walk(child);
      }
    }
  };
  walk(root);
  if (!Number.isFinite(left) || !Number.isFinite(top)) {
    const rect = root.getBoundingClientRect();
    left = rect.left;
    top = rect.top;
    right = rect.right;
    bottom = rect.bottom;
  }
  return {
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function measureInlineGeometry(
  request: U2SingleNodeSwapRequest,
  katex: HTMLElement,
): SingleNodeBaselineGeometry {
  const paragraph =
    request.wrapper.closest<HTMLElement>('p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th') ??
    request.wrapper.parentElement ??
    request.wrapper;
  const computed = getComputedStyle(paragraph);
  const fontSize = Number.parseFloat(computed.fontSize) || 16;
  const lineHeightValue =
    computed.lineHeight === 'normal' ? fontSize * 1.2 : Number.parseFloat(computed.lineHeight);
  const lineHeight = Number.isFinite(lineHeightValue) && lineHeightValue > 0 ? lineHeightValue : fontSize * 1.2;
  const fontFamily = computed.fontFamily || 'serif';

  const line = document.createElement('div');
  line.style.cssText =
    'position:absolute;left:0;top:0;white-space:nowrap;overflow:visible;' +
    `font-family:${fontFamily};font-size:${fontSize}px;line-height:${lineHeight}px;` +
    'background:#fff;color:#000;opacity:0.001;pointer-events:none;';
  line.innerHTML =
    '<span>Ag</span>' +
    '<span class="u2b-probe" style="display:inline-block;width:0;height:0;overflow:visible;vertical-align:baseline;line-height:0;"></span>' +
    '<span>a</span>' +
    '<span class="u2b-host"></span>' +
    '<span>Ag</span>';
  const probe = line.querySelector<HTMLElement>('.u2b-probe');
  const text = line.children[2] as HTMLElement | null;
  const host = line.querySelector<HTMLElement>('.u2b-host');
  if (!probe || !text || !host) {
    throw new Error('U2 inline measurement line missing');
  }
  const katexClone = katex.cloneNode(true) as HTMLElement;
  host.appendChild(katexClone);
  document.body.appendChild(line);
  try {
    const probeRect = probe.getBoundingClientRect();
    const katexRect = katexClone.getBoundingClientRect();
    const textRect = text.getBoundingClientRect();
    const baselineTopPx = probeRect.bottom;
    const widthPx = Math.max(1, katexRect.width);
    const heightPx = Math.max(1, katexRect.height);
    const lineBoxTrimPx = Math.max(0, katexRect.bottom - textRect.bottom);
    const trimmedHeightPx = Math.max(1, heightPx - lineBoxTrimPx);
    return {
      widthPx,
      heightPx: trimmedHeightPx,
      baselineOffsetTopPx: Math.max(0, baselineTopPx - katexRect.top),
      descenderPx: Math.max(0, trimmedHeightPx - (baselineTopPx - katexRect.top)),
      verticalAlignPx:
        (baselineTopPx - katexRect.top) - trimmedHeightPx,
    };
  } finally {
    line.remove();
  }
}

function measureBlockGeometry(katex: HTMLElement): SingleNodeBaselineGeometry {
  const bounds = measureContentBounds(katex);
  return {
    widthPx: bounds.width,
    heightPx: bounds.height,
    baselineOffsetTopPx: 0,
    descenderPx: 0,
    verticalAlignPx: 0,
  };
}

async function generateRasterDataUrl(
  katex: HTMLElement,
  width: number,
  height: number,
): Promise<string> {
  const dpr = 2;
  const rasterWidth = Math.max(1, Math.ceil(width * dpr));
  const rasterHeight = Math.max(1, Math.ceil(height * dpr));
  const clone = katex.cloneNode(true) as HTMLElement;
  const holder = document.createElement('div');
  holder.style.cssText =
    `position:absolute;left:0;top:0;width:${width}px;height:${height}px;` +
    'overflow:visible;background:transparent;color:#000;';
  holder.appendChild(clone);
  document.body.appendChild(holder);
  const serialized = new XMLSerializer().serializeToString(holder);
  holder.remove();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${rasterWidth}" height="${rasterHeight}"><foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
  const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('U2 raster SVG decode failed'));
    img.src = svgDataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = rasterWidth;
  canvas.height = rasterHeight;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('U2 raster canvas context unavailable');
  }
  context.drawImage(image, 0, 0, rasterWidth, rasterHeight);
  return canvas.toDataURL('image/png');
}

const processor: SingleNodeBatchProcessor<U2SingleNodeSwapRequest, HTMLElement | null> =
  createSingleNodeBatchProcessor<U2SingleNodeSwapRequest, HTMLElement | null>({
    batchSize: BATCH_SIZE,
    concurrency: CONCURRENCY,
    maxSwapPerFrame: MAX_SWAP_PER_FRAME,
    async generate(task) {
      const request = task.data;
      if (!request || !request.isCurrent()) {
        return null;
      }
      try {
        const katex = request.preview.querySelector<HTMLElement>('.katex');
        if (!katex) {
          return null;
        }
        const geometry =
          request.display === 'yes'
            ? measureBlockGeometry(katex)
            : measureInlineGeometry(request, katex);
        const raster = await generateRasterDataUrl(katex, geometry.widthPx, geometry.heightPx);
        const element = await createSingleNodeFormulaElement(
          'bitmap-data-url' satisfies U2BatchRenderKind,
          {
            latex: request.latex,
            display: request.display,
            html: request.html,
            dpr2DataUrl: raster,
          },
          geometry,
        );
        element.dataset.u2SingleNode = '1';
        element.dataset.u2TaskId = request.id;
        element.dataset.u2BaselineOffsetTop = String(geometry.baselineOffsetTopPx);
        element.dataset.u2Width = String(geometry.widthPx);
        element.dataset.u2Height = String(geometry.heightPx);
        return element;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        publishDiagnostics();
        return null;
      }
    },
    swap(result, task) {
      const request = task.data;
      if (!request) {
        return;
      }
      pendingIds.delete(request.id);
      if (!result || !request.isCurrent()) {
        failedCount += 1;
        requests.delete(request.id);
        return;
      }
      const timing = swapTimings.get(request.id);
      if (timing) {
        swapReadyValues.push(performance.now() - timing.startedAt);
        swapTimings.delete(request.id);
      }
      request.preview.replaceChildren(result);
      request.preview.dataset.u2Swapped = '1';
      if (request.display === 'no') {
        request.preview.style.display = 'inline-block';
        request.preview.style.lineHeight = '0';
        request.preview.style.verticalAlign = 'baseline';
        request.wrapper.style.display = 'inline-block';
        request.wrapper.style.alignItems = 'normal';
        request.wrapper.style.minHeight = '0';
        request.wrapper.style.lineHeight = '0';
        request.wrapper.style.verticalAlign = 'baseline';
        request.wrapper.style.overflow = 'visible';
      } else {
        request.preview.style.minHeight = '0';
        request.preview.style.display = 'block';
        request.preview.style.overflow = 'visible';
        request.wrapper.style.minHeight = '0';
        request.wrapper.style.display = 'block';
        request.wrapper.style.overflow = 'visible';
        request.wrapper.style.contain = 'none';
        request.wrapper.style.contentVisibility = 'visible';
      }
      swappedIds.add(request.id);
      completedCount += 1;
      request.onSwapped?.(result);
      publishDiagnostics();
    },
  });

function publishDiagnostics(): void {
  if (typeof window === 'undefined') {
    return;
  }
  const benchmarkWindow = window as unknown as Record<string, unknown>;
  benchmarkWindow.__marivellU2Activation = {
    getDiagnostics: getU2ActivationDiagnostics,
    reset: resetU2ActivationDiagnosticsForTest,
  };
}

export function requestU2SingleNodeSwap(request: U2SingleNodeSwapRequest): boolean {
  if (!request.isCurrent() || pendingIds.has(request.id) || swappedIds.has(request.id)) {
    return false;
  }
  pendingIds.add(request.id);
  requests.set(request.id, request);
  requestedCount += 1;
  swapTimings.set(request.id, { id: request.id, startedAt: performance.now() });
  processor.enqueue([
    {
      key: request.id,
      priority: request.priority,
      data: request,
    },
  ]);
  maxQueueDepth = Math.max(maxQueueDepth, processor.size() + pendingIds.size);
  publishDiagnostics();
  return true;
}

export function cancelU2SingleNodeSwap(id: string): void {
  if (pendingIds.delete(id)) {
    cancelledCount += 1;
  }
  swapTimings.delete(id);
  requests.delete(id);
  processor.cancel(id);
  publishDiagnostics();
}

export function restoreU2SingleNodePreview(id: string): void {
  const wasPending = pendingIds.delete(id);
  const wasSwapped = swappedIds.delete(id);
  if (wasPending || wasSwapped) {
    cancelledCount += 1;
  }
  swapTimings.delete(id);
  const request = requests.get(id);
  requests.delete(id);
  processor.cancel(id);
  request?.restore();
  publishDiagnostics();
}

export function restoreAllU2SingleNodePreviews(): void {
  for (const id of Array.from(swappedIds)) {
    restoreU2SingleNodePreview(id);
  }
  for (const id of Array.from(pendingIds)) {
    restoreU2SingleNodePreview(id);
  }
}

export function cancelAllU2SingleNodeSwaps(): void {
  for (const id of Array.from(pendingIds)) {
    cancelU2SingleNodeSwap(id);
  }
}

export function getU2ActivationDiagnostics(): U2ActivationMetrics {
  const singleNodeDomCount =
    typeof document !== 'undefined'
      ? document.querySelectorAll<HTMLElement>('[data-u2-single-node="1"]').length
      : 0;
  return {
    enabled: isU2Enabled(),
    requested: requestedCount,
    completed: completedCount,
    cancelled: cancelledCount,
    failed: failedCount,
    pending: pendingIds.size,
    swapped: swappedIds.size,
    queueDepth: processor.size(),
    maxQueueDepth,
    singleNodeDomCount,
    swapReadyMs: percentile(swapReadyValues),
    lastError,
  };
}

export function resetU2ActivationDiagnosticsForTest(): void {
  pendingIds.clear();
  swappedIds.clear();
  swapTimings.clear();
  swapReadyValues.length = 0;
  requestedCount = 0;
  completedCount = 0;
  cancelledCount = 0;
  failedCount = 0;
  maxQueueDepth = 0;
  lastError = null;
  publishDiagnostics();
}
