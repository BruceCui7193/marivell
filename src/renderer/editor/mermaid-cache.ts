const mermaidHeightCache = new Map<string, number>();

export function getMermaidCacheKey(theme: string, code: string): string {
  return `${theme}\u0000${code}`;
}

export function getCachedMermaidHeight(theme: string, code: string): number | null {
  const height = mermaidHeightCache.get(getMermaidCacheKey(theme, code));
  return typeof height === 'number' ? height : null;
}

export function setCachedMermaidHeight(theme: string, code: string, height: number): void {
  mermaidHeightCache.set(getMermaidCacheKey(theme, code), height);
}

export function clearMermaidHeightCache(): void {
  mermaidHeightCache.clear();
}
