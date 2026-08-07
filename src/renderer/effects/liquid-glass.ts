/**
 * Liquid glass renderer for the editor UI. The blur is native CSS
 * `backdrop-filter` so portal menus render consistently across platforms;
 * the generated specular texture adds a subtle edge highlight per surface.
 */

export interface LiquidGlassConfig {
  glassThickness: number;
  bezelWidth: number;
  refractiveIndex: number;
  scaleRatio: number;
  blurAmount: number;
  specularOpacity: number;
  specularSaturation: number;
  outerShadowBlur: number;
  maxMapSize: number;
}

export const LIQUID_GLASS_CONFIG: LiquidGlassConfig = {
  glassThickness: 120,
  bezelWidth: 60,
  refractiveIndex: 3,
  scaleRatio: 1,
  blurAmount: 1.6,
  specularOpacity: 0.42,
  specularSaturation: 4,
  outerShadowBlur: 26,
  maxMapSize: 320,
};

export const LIQUID_GLASS_SURFACE_SELECTOR = [
  '.toolbar',
  '.toolbar-menu',
  '.toolbar-submenu',
  '.toolbar-compact-panel',
  '.theme-panel',
  '.context-menu',
  '.image-action-menu',
  '.app-dialog',
  '.sidebar',
  '.status-bar',
  '.search-panel',
  '.editor-loading',
  '.code-block-node__language-menu',
  '.code-block-node__toolbar',
  '.app-exporting',
].join(',');

interface SurfaceRecord {
  element: HTMLElement;
  specular: string;
}

const state = {
  enabled: false,
  entries: new Map<HTMLElement, SurfaceRecord>(),
  mutationObserver: null as MutationObserver | null,
  resizeObserver: null as ResizeObserver | null,
  pending: new Set<HTMLElement>(),
  rafId: 0,
  mapCache: new Map<string, string>(),
};

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

function generateSpecularMap(
  width: number,
  height: number,
  radius: number,
  bezelWidth: number,
  angle: number,
): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }

  const image = context.createImageData(width, height);
  const data = image.data;
  data.fill(0);

  const safeRadius = Math.max(2, radius);
  const safeBezel = Math.max(1, Math.min(bezelWidth, safeRadius - 1, Math.min(width, height) / 2 - 1));
  const rSq = safeRadius * safeRadius;
  const r1Sq = (safeRadius + 1) ** 2;
  const rBSq = Math.max(safeRadius - safeBezel, 0) ** 2;
  const widthBody = width - safeRadius * 2;
  const heightBody = height - safeRadius * 2;
  const light = [Math.cos(angle), Math.sin(angle)];

  for (let y1 = 0; y1 < height; y1 += 1) {
    for (let x1 = 0; x1 < width; x1 += 1) {
      const x = x1 < safeRadius ? x1 - safeRadius : x1 >= width - safeRadius ? x1 - safeRadius - widthBody : 0;
      const y = y1 < safeRadius ? y1 - safeRadius : y1 >= height - safeRadius ? y1 - safeRadius - heightBody : 0;
      const dSq = x * x + y * y;
      if (dSq > r1Sq || dSq < rBSq) {
        continue;
      }
      const dist = Math.sqrt(dSq);
      const fromSide = safeRadius - dist;
      const op = dSq < rSq ? 1 : 1 - (dist - Math.sqrt(rSq)) / (Math.sqrt(r1Sq) - Math.sqrt(rSq));
      if (op <= 0 || dist === 0) {
        continue;
      }
      const cos = x / dist;
      const sin = -y / dist;
      const dot = Math.abs(cos * light[0] + sin * light[1]);
      const edge = Math.sqrt(Math.max(0, 1 - (1 - fromSide) ** 2));
      const coefficient = dot * edge;
      const color = clampByte(255 * coefficient);
      const alpha = clampByte(color * coefficient * op);
      const index = (y1 * width + x1) * 4;
      data[index] = color;
      data[index + 1] = color;
      data[index + 2] = color;
      data[index + 3] = alpha;
    }
  }

  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

function getSurfaceRadius(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const corners = [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ];
  let maxRadius = 0;
  for (const corner of corners) {
    const value = Number.parseFloat(corner);
    if (Number.isFinite(value)) {
      maxRadius = Math.max(maxRadius, value);
    }
  }
  return maxRadius;
}

function isSurfaceVisible(element: HTMLElement): boolean {
  if (!element.isConnected) {
    return false;
  }
  if (element.matches('.is-closed, .is-hidden, .is-source-hidden')) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width >= 12 && rect.height >= 12;
}

function getSpecularAsset(width: number, height: number, radius: number): string | null {
  const config = LIQUID_GLASS_CONFIG;
  const scaleFactor = Math.min(1, config.maxMapSize / Math.max(width, height));
  const mapWidth = Math.max(8, Math.round(width * scaleFactor));
  const mapHeight = Math.max(8, Math.round(height * scaleFactor));
  const mapRadius = Math.max(2, radius * scaleFactor);
  const mapBezel = Math.max(1, Math.min(mapRadius, mapRadius * 0.7));
  const cacheKey = `${mapWidth}x${mapHeight}-${mapRadius.toFixed(1)}-${mapBezel.toFixed(1)}`;
  const cached = state.mapCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const specular = generateSpecularMap(mapWidth, mapHeight, mapRadius, mapBezel * 2.5, Math.PI / 3);
  if (!specular) {
    return null;
  }
  if (state.mapCache.size >= 32) {
    const oldestKey = state.mapCache.keys().next().value as string | undefined;
    if (oldestKey) {
      state.mapCache.delete(oldestKey);
    }
  }
  state.mapCache.set(cacheKey, specular);
  return specular;
}

function updateSurface(element: HTMLElement): void {
  const record = state.entries.get(element);
  if (!record || !isSurfaceVisible(element)) {
    return;
  }

  const rect = element.getBoundingClientRect();
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (width < 12 || height < 12) {
    return;
  }
  const radius = Math.max(4, getSurfaceRadius(element));
  const specular = getSpecularAsset(width, height, radius);
  if (!specular) {
    return;
  }

  record.specular = specular;
  element.style.setProperty('--liquid-glass-specular', `url("${specular}")`);
}

function flushPending(): void {
  state.rafId = 0;
  const pending = Array.from(state.pending);
  state.pending.clear();
  for (const element of pending) {
    updateSurface(element);
  }
}

function schedule(element: HTMLElement): void {
  if (!state.enabled) {
    return;
  }
  state.pending.add(element);
  if (state.rafId === 0) {
    state.rafId = window.requestAnimationFrame(flushPending);
  }
}

function registerSurface(element: HTMLElement): void {
  if (state.entries.has(element)) {
    schedule(element);
    return;
  }
  if (!isSurfaceVisible(element)) {
    return;
  }

  state.entries.set(element, { element, specular: '' });
  element.dataset.liquidGlass = 'true';
  state.resizeObserver?.observe(element);
  schedule(element);
}

function unregisterSurface(element: HTMLElement): void {
  const record = state.entries.get(element);
  if (!record) {
    return;
  }
  delete element.dataset.liquidGlass;
  element.style.removeProperty('--liquid-glass-specular');
  state.entries.delete(element);
  state.pending.delete(element);
  state.resizeObserver?.unobserve(element);
}

function reconcileSurfaces(): void {
  if (!state.enabled) {
    return;
  }

  const elements = Array.from(document.querySelectorAll<HTMLElement>(LIQUID_GLASS_SURFACE_SELECTOR));
  const connected = new Set(elements);
  for (const [element] of state.entries) {
    if (!connected.has(element) || !element.isConnected) {
      unregisterSurface(element);
    }
  }
  for (const element of elements) {
    registerSurface(element);
  }
}

function mutationNeedsReconcile(records: MutationRecord[]): boolean {
  for (const record of records) {
    if (record.type === 'attributes' && record.target instanceof HTMLElement) {
      if (record.target.matches(LIQUID_GLASS_SURFACE_SELECTOR)) {
        return true;
      }
    }
    if (record.type !== 'childList') {
      continue;
    }
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      if (!(node instanceof Element)) {
        continue;
      }
      if (node.matches(LIQUID_GLASS_SURFACE_SELECTOR) || node.querySelector(LIQUID_GLASS_SURFACE_SELECTOR)) {
        return true;
      }
    }
  }
  return false;
}

function startObservers(): void {
  if (state.mutationObserver || !document.body) {
    return;
  }

  state.mutationObserver = new MutationObserver((records) => {
    if (mutationNeedsReconcile(records)) {
      reconcileSurfaces();
    }
  });
  state.mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'aria-hidden'],
  });

  state.resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target instanceof HTMLElement && state.entries.has(entry.target)) {
        schedule(entry.target);
      }
    }
  });
  for (const element of state.entries.keys()) {
    state.resizeObserver.observe(element);
  }
}

function stopObservers(): void {
  state.mutationObserver?.disconnect();
  state.mutationObserver = null;
  state.resizeObserver?.disconnect();
  state.resizeObserver = null;
}

function syncLiquidGlassVariables(enabled: boolean): void {
  const style = document.documentElement.style;
  const config = LIQUID_GLASS_CONFIG;
  if (!enabled) {
    style.removeProperty('--liquid-glass-blur');
    style.removeProperty('--liquid-glass-specular-opacity');
    style.removeProperty('--liquid-glass-outer-blur');
    return;
  }
  style.setProperty('--liquid-glass-blur', `${Math.max(12, config.blurAmount * 8)}px`);
  style.setProperty('--liquid-glass-specular-opacity', `${config.specularOpacity * 0.6}`);
  style.setProperty('--liquid-glass-outer-blur', `${config.outerShadowBlur}px`);
}

export function setLiquidGlassEnabled(enabled: boolean): void {
  if (enabled === state.enabled) {
    return;
  }

  state.enabled = enabled;
  if (!enabled) {
    stopObservers();
    if (state.rafId !== 0) {
      window.cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }
    for (const element of Array.from(state.entries.keys())) {
      unregisterSurface(element);
    }
    state.pending.clear();
    state.mapCache.clear();
    syncLiquidGlassVariables(false);
    return;
  }

  syncLiquidGlassVariables(true);
  reconcileSurfaces();
  startObservers();
}
