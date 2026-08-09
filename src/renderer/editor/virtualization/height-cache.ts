const nodeHeightCache = new Map<string, number>();
const NODE_HEIGHT_CACHE_LIMIT = 5000;
const nodeHeightCacheInvalidationListeners = new Set<() => void>();

export function getHeightCacheKey(
  nodeType: string,
  content: string,
  widthBucket: number,
  theme: string,
  zoom: number,
  fontVersion: string,
): string {
  return `${nodeType}\u0000${content}\u0000${widthBucket}\u0000${theme}\u0000${zoom}\u0000${fontVersion}`;
}

export function getCachedNodeHeight(key: string): number | null {
  if (!nodeHeightCache.has(key)) {
    return null;
  }

  const height = nodeHeightCache.get(key)!;
  nodeHeightCache.delete(key);
  nodeHeightCache.set(key, height);
  return height;
}

export function setCachedNodeHeight(key: string, height: number): void {
  if (nodeHeightCache.has(key)) {
    nodeHeightCache.delete(key);
  }
  nodeHeightCache.set(key, height);

  if (nodeHeightCache.size <= NODE_HEIGHT_CACHE_LIMIT) {
    return;
  }

  const oldestKey = nodeHeightCache.keys().next().value;
  if (typeof oldestKey === 'string') {
    nodeHeightCache.delete(oldestKey);
  }
}

export function clearNodeHeightCache(): void {
  nodeHeightCache.clear();
  for (const listener of nodeHeightCacheInvalidationListeners) {
    try {
      listener();
    } catch {
      // Invalidation listeners are lifecycle hooks and must not break cache clearing.
    }
  }
}

export function subscribeNodeHeightCacheInvalidation(listener: () => void): () => void {
  nodeHeightCacheInvalidationListeners.add(listener);
  return () => {
    nodeHeightCacheInvalidationListeners.delete(listener);
  };
}

export function unsubscribeNodeHeightCacheInvalidation(listener: () => void): void {
  nodeHeightCacheInvalidationListeners.delete(listener);
}
