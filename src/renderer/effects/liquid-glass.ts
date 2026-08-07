/**
 * Shared liquid glass renderer adapted from archisvaze/liquid-glass's SVG
 * displacement approach. It keeps one filter def per visible UI surface and
 * rebuilds maps only when a surface opens or resizes.
 */

export interface LiquidGlassConfig {
  glassThickness: number;
  bezelWidth: number;
  refractiveIndex: number;
  scaleRatio: number;
  blurAmount: number;
  specularOpacity: number;
  specularSaturation: number;
  innerShadowBlur: number;
  innerShadowSpread: number;
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
  innerShadowBlur: 20,
  innerShadowSpread: -5,
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

const SVG_NS = 'http://www.w3.org/2000/svg';
interface SurfaceRecord {
  element: HTMLElement;
  filterId: string;
  filterMarkup: string;
}

interface MapAssets {
  displacement: string;
  specular: string;
  scale: number;
}

const state = {
  enabled: false,
  svg: null as SVGSVGElement | null,
  defs: null as SVGDefsElement | null,
  entries: new Map<HTMLElement, SurfaceRecord>(),
  mutationObserver: null as MutationObserver | null,
  resizeObserver: null as ResizeObserver | null,
  pending: new Set<HTMLElement>(),
  rafId: 0,
  nextFilterId: 0,
  mapCache: new Map<string, MapAssets>(),
};

function surfaceHeight(t: number): number {
  const s = 1 - t;
  return Math.pow(1 - s * s * s * s, 0.25);
}

function calculateRefractionProfile(
  glassThickness: number,
  bezelWidth: number,
  ior: number,
  samples: number,
): Float64Array {
  const profile = new Float64Array(samples);
  if (bezelWidth <= 0 || glassThickness <= 0) {
    return profile;
  }

  const eta = 1 / ior;
  for (let i = 0; i < samples; i += 1) {
    const x = i / samples;
    const y = surfaceHeight(x);
    const dx = x < 1 ? 0.0001 : -0.0001;
    const y2 = surfaceHeight(x + dx);
    const deriv = (y2 - y) / dx;
    const mag = Math.sqrt(deriv * deriv + 1);
    const nx = -deriv / mag;
    const ny = -1 / mag;
    const dot = ny;
    const k = 1 - eta * eta * (1 - dot * dot);
    if (k < 0) {
      continue;
    }
    const sq = Math.sqrt(k);
    const refX = -(eta * dot + sq) * nx;
    const refY = eta - (eta * dot + sq) * ny;
    profile[i] = refX * ((y * bezelWidth + glassThickness) / refY);
  }

  return profile;
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

function generateDisplacementMap(
  width: number,
  height: number,
  radius: number,
  bezelWidth: number,
  profile: Float64Array,
  maxDisp: number,
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
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 128;
    data[i + 1] = 128;
    data[i + 2] = 0;
    data[i + 3] = 255;
  }

  const safeRadius = Math.max(2, radius);
  const safeBezel = Math.max(1, Math.min(bezelWidth, safeRadius - 1, Math.min(width, height) / 2 - 1));
  const rSq = safeRadius * safeRadius;
  const r1Sq = (safeRadius + 1) ** 2;
  const rBSq = Math.max(safeRadius - safeBezel, 0) ** 2;
  const widthBody = width - safeRadius * 2;
  const heightBody = height - safeRadius * 2;
  const profileLength = profile.length;

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
      const sin = y / dist;
      const bezelIndex = Math.min(((fromSide / safeBezel) * profileLength) | 0, profileLength - 1);
      const displacement = profile[bezelIndex] || 0;
      const dX = (-cos * displacement) / maxDisp;
      const dY = (-sin * displacement) / maxDisp;
      const index = (y1 * width + x1) * 4;
      data[index] = clampByte(128 + dX * 127 * op + 0.5);
      data[index + 1] = clampByte(128 + dY * 127 * op + 0.5);
    }
  }

  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
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

function ensureSvg(): void {
  if (state.svg && state.defs) {
    return;
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.style.position = 'absolute';
  svg.style.overflow = 'hidden';
  const defs = document.createElementNS(SVG_NS, 'defs');
  svg.appendChild(defs);
  document.body.appendChild(svg);
  state.svg = svg;
  state.defs = defs;
}

function removeSvg(): void {
  state.svg?.remove();
  state.svg = null;
  state.defs = null;
}

function buildFilterMarkup(
  filterId: string,
  width: number,
  height: number,
  assets: MapAssets,
): string {
  const config = LIQUID_GLASS_CONFIG;
  return [
    `<filter id="${filterId}" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">`,
    `<feGaussianBlur in="SourceGraphic" stdDeviation="${config.blurAmount}" result="blurred_source" />`,
    `<feImage href="${assets.displacement}" x="0" y="0" width="${width}" height="${height}" result="disp_map" />`,
    `<feDisplacementMap in="blurred_source" in2="disp_map" scale="${assets.scale}" xChannelSelector="R" yChannelSelector="G" result="displaced" />`,
    `<feColorMatrix in="displaced" type="saturate" values="${config.specularSaturation}" result="displaced_sat" />`,
    `<feImage href="${assets.specular}" x="0" y="0" width="${width}" height="${height}" result="spec_layer" />`,
    `<feComposite in="displaced_sat" in2="spec_layer" operator="in" result="spec_masked" />`,
    `<feComponentTransfer in="spec_layer" result="spec_faded">`,
    `<feFuncA type="linear" slope="${config.specularOpacity}" />`,
    `</feComponentTransfer>`,
    `<feBlend in="spec_masked" in2="displaced" mode="normal" result="with_sat" />`,
    `<feBlend in="spec_faded" in2="with_sat" mode="normal" />`,
    `</filter>`,
  ].join('');
}

function getMapAssets(width: number, height: number, radius: number, bezelWidth: number): MapAssets | null {
  const config = LIQUID_GLASS_CONFIG;
  const scaleFactor = Math.min(1, config.maxMapSize / Math.max(width, height));
  const mapWidth = Math.max(8, Math.round(width * scaleFactor));
  const mapHeight = Math.max(8, Math.round(height * scaleFactor));
  const mapRadius = Math.max(2, radius * scaleFactor);
  const mapBezel = Math.max(1, bezelWidth * scaleFactor);
  const cacheKey = `${mapWidth}x${mapHeight}-${mapRadius.toFixed(1)}-${mapBezel.toFixed(1)}-${config.glassThickness}-${config.blurAmount}`;
  const cached = state.mapCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const profile = calculateRefractionProfile(config.glassThickness, bezelWidth, config.refractiveIndex, 128);
  let maxDisp = 0;
  for (const value of profile) {
    maxDisp = Math.max(maxDisp, Math.abs(value));
  }
  maxDisp = Math.max(maxDisp, 1);
  const displacement = generateDisplacementMap(
    mapWidth,
    mapHeight,
    mapRadius,
    mapBezel,
    profile,
    maxDisp,
  );
  const specular = generateSpecularMap(mapWidth, mapHeight, mapRadius, mapBezel * 2.5, Math.PI / 3);
  if (!displacement || !specular) {
    return null;
  }

  const assets: MapAssets = {
    displacement,
    specular,
    scale: maxDisp * config.scaleRatio,
  };
  if (state.mapCache.size >= 24) {
    const oldestKey = state.mapCache.keys().next().value as string | undefined;
    if (oldestKey) {
      state.mapCache.delete(oldestKey);
    }
  }
  state.mapCache.set(cacheKey, assets);
  return assets;
}

function renderDefs(): void {
  if (!state.defs) {
    return;
  }
  state.defs.innerHTML = Array.from(state.entries.values())
    .map((entry) => entry.filterMarkup)
    .join('');
}

function updateSurface(element: HTMLElement): void {
  const record = state.entries.get(element);
  if (!record || !isSurfaceVisible(element)) {
    return;
  }

  const rect = element.getBoundingClientRect();
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  const radius = Math.max(4, getSurfaceRadius(element));
  const bezelWidth = Math.min(LIQUID_GLASS_CONFIG.bezelWidth, radius - 1, Math.min(width, height) / 2 - 1);
  if (width < 12 || height < 12 || bezelWidth <= 0) {
    return;
  }

  const assets = getMapAssets(width, height, radius, bezelWidth);
  if (!assets) {
    return;
  }

  record.filterMarkup = buildFilterMarkup(record.filterId, width, height, assets);
  element.style.setProperty('--liquid-glass-filter', `url("#${record.filterId}")`);
}

function flushPending(): void {
  state.rafId = 0;
  const pending = Array.from(state.pending);
  state.pending.clear();
  for (const element of pending) {
    updateSurface(element);
  }
  renderDefs();
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

  const record: SurfaceRecord = {
    element,
    filterId: `liquid-glass-${state.nextFilterId += 1}`,
    filterMarkup: '',
  };
  state.entries.set(element, record);
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
  element.style.removeProperty('--liquid-glass-filter');
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
  renderDefs();
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
  if (!enabled) {
    style.removeProperty('--liquid-glass-inner-blur');
    style.removeProperty('--liquid-glass-inner-spread');
    style.removeProperty('--liquid-glass-outer-blur');
    return;
  }

  const config = LIQUID_GLASS_CONFIG;
  style.setProperty('--liquid-glass-inner-blur', `${config.innerShadowBlur}px`);
  style.setProperty('--liquid-glass-inner-spread', `${config.innerShadowSpread}px`);
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
    removeSvg();
    return;
  }

  syncLiquidGlassVariables(true);
  ensureSvg();
  reconcileSurfaces();
  startObservers();
}
