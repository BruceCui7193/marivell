const formulaHtmlCache = new Map<string, string>();
const FORMULA_HTML_CACHE_LIMIT = 10_000;

export function getFormulaCacheKey(latex: string, display: string): string {
  return `${display === 'yes' ? 'block' : 'inline'}\u0000${latex}`;
}

export function seedFormulaHtmlCache(entries: Record<string, string>): number {
  let seeded = 0;
  for (const [key, html] of Object.entries(entries)) {
    if (formulaHtmlCache.has(key)) {
      formulaHtmlCache.delete(key);
    }
    formulaHtmlCache.set(key, html);
    seeded += 1;
    if (formulaHtmlCache.size > FORMULA_HTML_CACHE_LIMIT) {
      const oldestKey = formulaHtmlCache.keys().next().value;
      if (typeof oldestKey === 'string') {
        formulaHtmlCache.delete(oldestKey);
      }
    }
  }
  return seeded;
}

export function getCachedFormulaHtml(latex: string, display: string): string | null {
  const key = getFormulaCacheKey(latex, display);
  if (!formulaHtmlCache.has(key)) {
    return null;
  }
  const html = formulaHtmlCache.get(key)!;
  formulaHtmlCache.delete(key);
  formulaHtmlCache.set(key, html);
  return html;
}

export function clearFormulaHtmlCache(): void {
  formulaHtmlCache.clear();
}
