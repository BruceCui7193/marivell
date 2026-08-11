export const FORMULA_TEMPLATE_CACHE_MAX_COUNT = 2400;
export const FORMULA_TEMPLATE_CACHE_MAX_BYTES = 48 * 1024 * 1024;

interface FormulaTemplateEntry {
  template: HTMLTemplateElement;
  html: string;
  bytes: number;
}

export interface FormulaTemplateCacheStats {
  hits: number;
  misses: number;
  bytes: number;
  count: number;
  evictions: number;
  injectCount: number;
  injectP50Ms: number;
  injectP95Ms: number;
  injectMaxMs: number;
}

const formulaTemplates = new Map<string, FormulaTemplateEntry>();
let formulaTemplateBytes = 0;
let formulaTemplateHits = 0;
let formulaTemplateMisses = 0;
let formulaTemplateEvictions = 0;
const katexInjectTimings: number[] = [];
const MAX_KATEX_INJECT_TIMINGS = 10_000;

function getHtmlByteLength(html: string): number {
  try {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(html).length;
    }
  } catch {
    // Fall back to a conservative UTF-16 estimate in non-browser contexts.
  }
  return html.length * 2;
}

function evictFormulaTemplates(): void {
  while (
    formulaTemplates.size > FORMULA_TEMPLATE_CACHE_MAX_COUNT ||
    formulaTemplateBytes > FORMULA_TEMPLATE_CACHE_MAX_BYTES
  ) {
    const oldestKey = formulaTemplates.keys().next().value;
    if (typeof oldestKey !== 'string') {
      return;
    }
    const entry = formulaTemplates.get(oldestKey);
    if (!entry) {
      return;
    }
    formulaTemplates.delete(oldestKey);
    formulaTemplateBytes = Math.max(0, formulaTemplateBytes - entry.bytes);
    formulaTemplateEvictions += 1;
  }
}

function buildFormulaTemplate(html: string): HTMLTemplateElement {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template;
}

export function getOrCreateFormulaTemplate(
  key: string,
  html?: string | null,
): HTMLTemplateElement | null {
  const existing = formulaTemplates.get(key);
  if (existing) {
    if (html !== undefined && html !== existing.html) {
      formulaTemplates.delete(key);
      formulaTemplateBytes = Math.max(0, formulaTemplateBytes - existing.bytes);
    } else {
      formulaTemplates.delete(key);
      formulaTemplates.set(key, existing);
      formulaTemplateHits += 1;
      return existing.template;
    }
  }

  formulaTemplateMisses += 1;
  if (!html || typeof document === 'undefined') {
    return null;
  }

  let template: HTMLTemplateElement;
  try {
    template = buildFormulaTemplate(html);
  } catch {
    return null;
  }

  const bytes = getHtmlByteLength(html);
  if (bytes > FORMULA_TEMPLATE_CACHE_MAX_BYTES) {
    return template;
  }

  formulaTemplates.set(key, { template, html, bytes });
  formulaTemplateBytes += bytes;
  evictFormulaTemplates();
  return template;
}

export function cloneFormulaTemplateContent(
  key: string,
  html?: string | null,
): DocumentFragment | null {
  const template = getOrCreateFormulaTemplate(key, html);
  if (template === null) {
    return null;
  }
  try {
    return template.content.cloneNode(true) as DocumentFragment;
  } catch {
    return null;
  }
}

export function recordKatexInjectMs(durationMs: number): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const target = window as unknown as {
      markdownEditor?: { getBenchmarkEnabled?: () => boolean };
    };
    if (!target.markdownEditor?.getBenchmarkEnabled?.()) {
      return;
    }
  } catch {
    return;
  }
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    katexInjectTimings.push(durationMs);
    if (katexInjectTimings.length >= MAX_KATEX_INJECT_TIMINGS) {
      katexInjectTimings.splice(0, 1000);
    }
  }
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = Array.from(values).sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(sorted.length * ratio)),
  );
  return sorted[index] ?? 0;
}

export function getFormulaTemplateCacheStatsForTest(): FormulaTemplateCacheStats {
  return {
    hits: formulaTemplateHits,
    misses: formulaTemplateMisses,
    bytes: formulaTemplateBytes,
    count: formulaTemplates.size,
    evictions: formulaTemplateEvictions,
    injectCount: katexInjectTimings.length,
    injectP50Ms: percentile(katexInjectTimings, 0.5),
    injectP95Ms: percentile(katexInjectTimings, 0.95),
    injectMaxMs: katexInjectTimings.length > 0
      ? Math.max(...katexInjectTimings)
      : 0,
  };
}

export function resetFormulaTemplateCacheStatsForTest(): void {
  formulaTemplateHits = 0;
  formulaTemplateMisses = 0;
  formulaTemplateEvictions = 0;
  katexInjectTimings.length = 0;
}

export function resetFormulaTemplateCacheForTest(): void {
  formulaTemplates.clear();
  formulaTemplateBytes = 0;
  formulaTemplateHits = 0;
  formulaTemplateMisses = 0;
  formulaTemplateEvictions = 0;
  katexInjectTimings.length = 0;
}
