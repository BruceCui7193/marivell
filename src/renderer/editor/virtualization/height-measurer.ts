import { getHeightCacheKey, setCachedNodeWidth } from './height-cache';

export interface FormulaHeightMeasurementItem {
  key: string;
  html: string;
  display: 'yes' | 'no';
}

export interface FormulaHeightSource {
  key: string;
  latex: string;
  display: 'yes' | 'no';
}

const WIDTH_BUCKET_SIZE = 160;

let editorSurfaceCache: HTMLElement | null = null;
let editorSurfaceCacheWidth = -1;
let editorWidthBucketCache: number | null = null;

export function getEditorWidthBucket(element?: HTMLElement | null): number {
  const frame = element?.closest('.editor-frame') as HTMLElement | null;
  if (
    editorSurfaceCache?.isConnected === false ||
    (frame !== null && editorSurfaceCache?.closest('.editor-frame') !== frame)
  ) {
    editorSurfaceCache = null;
    editorSurfaceCacheWidth = -1;
    editorWidthBucketCache = null;
  }
  const editorSurface =
    editorSurfaceCache ??
    frame?.querySelector<HTMLElement>('.ProseMirror') ??
    (typeof document !== 'undefined'
      ? document.querySelector<HTMLElement>('.editor-surface')
      : null);
  if (editorSurface !== editorSurfaceCache) {
    editorSurfaceCache = editorSurface;
    editorSurfaceCacheWidth = -1;
    editorWidthBucketCache = null;
  }
  const width =
    editorSurface?.clientWidth ||
    editorSurface?.getBoundingClientRect().width ||
    frame?.clientWidth ||
    (typeof document !== 'undefined'
      ? document.documentElement?.clientWidth
      : 0) ||
    (typeof window !== 'undefined' ? window.innerWidth : 0) ||
    800;
  const bucket = Math.max(1, Math.floor(width / WIDTH_BUCKET_SIZE));
  if (editorWidthBucketCache !== null && editorSurfaceCacheWidth === width) {
    return editorWidthBucketCache;
  }
  editorSurfaceCacheWidth = width;
  editorWidthBucketCache = bucket;
  return bucket;
}

let cachedEditorThemeKey: string | null = null;
let cachedEditorZoomKey: number | null = null;
let cachedEditorFontVersionKey: string | null = null;

export function resetEditorEnvironmentKeyCache(): void {
  cachedEditorThemeKey = null;
  cachedEditorZoomKey = null;
  cachedEditorFontVersionKey = null;
}

export function getEditorThemeKey(): string {
  if (cachedEditorThemeKey !== null) {
    return cachedEditorThemeKey;
  }
  if (typeof document === 'undefined') {
    cachedEditorThemeKey = 'light:default';
    return cachedEditorThemeKey;
  }

  const root = document.documentElement;
  const theme = root?.dataset.theme ?? 'light';
  const palette = root?.dataset.colorScheme ?? 'default';
  cachedEditorThemeKey = `${theme}:${palette}`;
  return cachedEditorThemeKey;
}

export function getEditorZoomKey(): number {
  if (cachedEditorZoomKey !== null) {
    return cachedEditorZoomKey;
  }
  if (typeof window === 'undefined') {
    cachedEditorZoomKey = 1;
    return cachedEditorZoomKey;
  }
  cachedEditorZoomKey = window.devicePixelRatio || 1;
  return cachedEditorZoomKey;
}

export function getEditorFontVersionKey(): string {
  if (cachedEditorFontVersionKey !== null) {
    return cachedEditorFontVersionKey;
  }
  if (typeof document === 'undefined') {
    cachedEditorFontVersionKey = 'default';
    return cachedEditorFontVersionKey;
  }

  const root = document.documentElement;
  if (root?.dataset.fontVersion) {
    cachedEditorFontVersionKey = root.dataset.fontVersion;
    return cachedEditorFontVersionKey;
  }

  try {
    const font = getComputedStyle(root).getPropertyValue('--ui-font').trim();
    if (font) {
      cachedEditorFontVersionKey = font;
      return cachedEditorFontVersionKey;
    }
  } catch {
    // Some jsdom environments do not implement getComputedStyle fully.
  }

  cachedEditorFontVersionKey = 'default';
  return cachedEditorFontVersionKey;
}

export function getFormulaHeightKey(
  latex: string,
  display: 'yes' | 'no',
  element?: HTMLElement | null,
): string {
  return getHeightCacheKey(
    display === 'yes' ? 'blockMath' : 'inlineMath',
    latex,
    getEditorWidthBucket(element),
    getEditorThemeKey(),
    getEditorZoomKey(),
    getEditorFontVersionKey(),
  );
}

export function getNodeHeightKey(
  nodeType: string,
  content: string,
  element?: HTMLElement | null,
): string {
  return getHeightCacheKey(
    nodeType,
    content,
    getEditorWidthBucket(element),
    getEditorThemeKey(),
    getEditorZoomKey(),
    getEditorFontVersionKey(),
  );
}

export function buildFormulaHeightMeasurementItems(
  sources: FormulaHeightSource[],
  formulaHtml: Record<string, string>,
  element?: HTMLElement | null,
): FormulaHeightMeasurementItem[] {
  const items: FormulaHeightMeasurementItem[] = [];

  for (const source of sources) {
    const html = formulaHtml[source.key];
    if (typeof html !== 'string' || !html) {
      continue;
    }

    items.push({
      key: getFormulaHeightKey(source.latex, source.display, element),
      html,
      display: source.display,
    });
  }

  return items;
}

const MEASUREMENT_CHUNK_SIZE = 48;

interface MeasurementChunk {
  items: FormulaHeightMeasurementItem[];
  resolve: (heights: Record<string, number>) => void;
}

interface PendingReadChunk {
  items: FormulaHeightMeasurementItem[];
  elements: HTMLElement[];
  measured: Record<string, number>;
  resolve: (heights: Record<string, number>) => void;
}

let writeQueue: MeasurementChunk[] = [];
let pendingReadChunk: PendingReadChunk | null = null;
let measurementLayer: HTMLDivElement | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let readTimer: ReturnType<typeof setTimeout> | null = null;
let measurementSuspended = false;

function cleanupMeasurementLayer(): void {
  if (!measurementLayer) {
    return;
  }

  measurementLayer.parentNode?.removeChild(measurementLayer);
  measurementLayer = null;
}

function cancelPendingMeasurements(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (readTimer !== null) {
    clearTimeout(readTimer);
    readTimer = null;
  }
  const queued = writeQueue.splice(0);
  const pending = pendingReadChunk;
  pendingReadChunk = null;
  cleanupMeasurementLayer();
  for (const chunk of queued) {
    chunk.resolve({});
  }
  pending?.resolve({});
}

export function setHeightMeasurementSuspended(suspended: boolean): void {
  measurementSuspended = suspended;
  if (suspended) {
    cancelPendingMeasurements();
  }
}

function ensureMeasurementLayer(): HTMLDivElement | null {
  try {
    if (measurementSuspended) {
      return null;
    }
    if (measurementLayer?.isConnected) {
      return measurementLayer;
    }

    if (typeof document === 'undefined' || !document.body) {
      return null;
    }

    const surface = document.querySelector<HTMLElement>('.editor-surface');
    const host = surface?.parentElement ?? document.body;
    const layer = document.createElement('div');
    layer.className = 'height-measurer';
    layer.setAttribute('aria-hidden', 'true');
    layer.style.position = 'absolute';
    layer.style.left = '0';
    layer.style.top = '0';
    layer.style.visibility = 'hidden';
    layer.style.pointerEvents = 'none';
    layer.style.zIndex = '-1';
    layer.style.setProperty('contain', 'strict');
    layer.style.width = surface?.clientWidth
      ? `${surface.clientWidth}px`
      : '100%';

    if (surface) {
      try {
        const surfaceStyle = getComputedStyle(surface);
        layer.style.fontFamily = surfaceStyle.fontFamily;
        layer.style.fontSize = surfaceStyle.fontSize;
        layer.style.lineHeight = surfaceStyle.lineHeight;
        layer.style.color = surfaceStyle.color;
      } catch {
        // jsdom can return incomplete computed styles; dimensions still work.
      }
    }

    host.appendChild(layer);
    measurementLayer = layer;
    return layer;
  } catch {
    return null;
  }
}

function createMeasurementSample(item: FormulaHeightMeasurementItem): {
  wrapper: HTMLElement;
  preview: HTMLElement;
} {
  const wrapper = document.createElement(item.display === 'yes' ? 'div' : 'span');
  wrapper.className =
    item.display === 'yes'
      ? 'math-block-node math-node-wrapper'
      : 'math-inline-node math-node-wrapper';

  const preview = document.createElement('span');
  preview.className = 'math-node-preview';
  preview.innerHTML = item.html;
  wrapper.appendChild(preview);

  // Keep measurement samples independent of the visible editor's
  // content-visibility optimization. The production rule can return the
  // intrinsic placeholder height for skipped content, which is not the real
  // KaTeX box height and would turn into anchor drift on activation.
  wrapper.style.setProperty('contain', 'none');
  wrapper.style.setProperty('content-visibility', 'visible');
  wrapper.style.setProperty('contain-intrinsic-size', 'auto none');
  preview.style.setProperty('contain', 'none');
  preview.style.setProperty('content-visibility', 'visible');

  return { wrapper, preview };
}

function readNodeHeight(element: HTMLElement): number {
  try {
    return Math.max(
      element.getBoundingClientRect().height,
      element.scrollHeight,
      element.clientHeight,
    );
  } catch {
    return 0;
  }
}

function scheduleWrite(): void {
  if (measurementSuspended) {
    const queued = writeQueue.splice(0);
    for (const chunk of queued) {
      chunk.resolve({});
    }
    return;
  }
  if (writeTimer !== null || writeQueue.length === 0) {
    return;
  }
  writeTimer = setTimeout(flushWrites, 0);
}

function flushWrites(): void {
  writeTimer = null;
  if (pendingReadChunk !== null || writeQueue.length === 0) {
    return;
  }

  const chunk = writeQueue.shift();
  if (!chunk) {
    return;
  }

  const layer = ensureMeasurementLayer();
  if (!layer) {
    chunk.resolve({});
    scheduleWrite();
    return;
  }

  const fragment = document.createDocumentFragment();
  const elements: HTMLElement[] = [];
  for (const item of chunk.items) {
    try {
      const { wrapper, preview } = createMeasurementSample(item);
      fragment.appendChild(wrapper);
      elements.push(preview);
    } catch {
      // A bad formula sample must not break the chunk.
    }
  }

  try {
    layer.appendChild(fragment);
  } catch {
    chunk.resolve({});
    scheduleWrite();
    return;
  }

  pendingReadChunk = {
    items: chunk.items,
    elements,
    measured: {},
    resolve: chunk.resolve,
  };
  readTimer = setTimeout(flushReads, 0);
}

function flushReads(): void {
  readTimer = null;
  const chunk = pendingReadChunk;
  pendingReadChunk = null;
  if (!chunk) {
    scheduleWrite();
    return;
  }

  for (let index = 0; index < chunk.items.length; index += 1) {
    const element = chunk.elements[index];
    if (!element) {
      continue;
    }
    const width = Math.max(
      element.getBoundingClientRect().width,
      element.parentElement?.getBoundingClientRect().width ?? 0,
    );
    const height =
      chunk.items[index].display === 'no' && element.parentElement
        ? Math.max(readNodeHeight(element), readNodeHeight(element.parentElement))
        : readNodeHeight(element);
    if (height > 0) {
      chunk.measured[chunk.items[index].key] = height;
    }
    if (width > 0) {
      setCachedNodeWidth(chunk.items[index].key, width);
    }
  }

  chunk.resolve(chunk.measured);

  if (writeQueue.length > 0) {
    scheduleWrite();
  } else {
    cleanupMeasurementLayer();
  }
}

export function measureFormulaHeights(
  items: FormulaHeightMeasurementItem[],
): Promise<Record<string, number>> {
  if (!items.length) {
    return Promise.resolve({});
  }

  if (typeof document === 'undefined') {
    return Promise.resolve({});
  }

  return new Promise((resolveAll) => {
    const heights: Record<string, number> = {};
    const chunks: FormulaHeightMeasurementItem[][] = [];
    for (let index = 0; index < items.length; index += MEASUREMENT_CHUNK_SIZE) {
      chunks.push(items.slice(index, index + MEASUREMENT_CHUNK_SIZE));
    }

    let remaining = chunks.length;
    const resolveChunk = (chunkHeights: Record<string, number>): void => {
      Object.assign(heights, chunkHeights);
      remaining -= 1;
      if (remaining === 0) {
        resolveAll(heights);
      }
    };

    for (const chunkItems of chunks) {
      try {
        writeQueue.push({ items: chunkItems, resolve: resolveChunk });
      } catch {
        remaining -= 1;
        if (remaining === 0) {
          resolveAll(heights);
        }
      }
    }
    scheduleWrite();
  });
}

export function resetHeightMeasurerForTest(): void {
  measurementSuspended = false;
  resetEditorEnvironmentKeyCache();
  editorSurfaceCache = null;
  editorSurfaceCacheWidth = -1;
  editorWidthBucketCache = null;
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (readTimer !== null) {
    clearTimeout(readTimer);
    readTimer = null;
  }

  const pending = [...writeQueue, ...(pendingReadChunk ? [{ items: pendingReadChunk.items, resolve: pendingReadChunk.resolve }] : [])];
  writeQueue = [];
  pendingReadChunk = null;
  cleanupMeasurementLayer();
  for (const chunk of pending) {
    chunk.resolve({});
  }
}
