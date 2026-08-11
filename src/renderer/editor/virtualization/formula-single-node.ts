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
