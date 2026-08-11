const nodeHeightCache = new Map<string, number>();
const nodeWidthCache = new Map<string, number>();
const NODE_HEIGHT_CACHE_LIMIT = 5000;
const nodeHeightCacheInvalidationListeners = new Set<() => void>();
const nodeHeightCacheSeededListeners = new Set<(keys: string[] | null) => void>();

function hashHeightContent(content: string): string {
  let hash1 = 2166136261;
  let hash2 = 2246822519;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    hash1 ^= code;
    hash1 = Math.imul(hash1, 16777619);
    hash2 ^= code;
    hash2 = Math.imul(hash2, 2246822519);
  }
  return `${hash1 >>> 0}:${hash2 >>> 0}:${content.length}`;
}

export function getHeightCacheKey(
  nodeType: string,
  content: string,
  widthBucket: number,
  theme: string,
  zoom: number,
  fontVersion: string,
): string {
  return `${nodeType}\u0000${widthBucket}\u0000${theme}\u0000${zoom}\u0000${fontVersion}\u0000${hashHeightContent(content)}`;
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

export function getCachedNodeWidth(key: string): number | null {
  if (!nodeWidthCache.has(key)) {
    return null;
  }
  const width = nodeWidthCache.get(key)!;
  nodeWidthCache.delete(key);
  nodeWidthCache.set(key, width);
  return width;
}

export function setCachedNodeWidth(key: string, width: number): void {
  if (nodeWidthCache.has(key)) {
    nodeWidthCache.delete(key);
  }
  nodeWidthCache.set(key, width);
  if (nodeWidthCache.size <= NODE_HEIGHT_CACHE_LIMIT) {
    return;
  }
  const oldestKey = nodeWidthCache.keys().next().value;
  if (typeof oldestKey === 'string') {
    nodeWidthCache.delete(oldestKey);
  }
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

export function notifyNodeHeightCacheSeeded(seededKeys?: Iterable<string>): void {
  const keys = seededKeys ? Array.from(seededKeys) : null;
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__marivellNodeHeightCacheSize =
      nodeHeightCache.size;
  }
  for (const listener of nodeHeightCacheSeededListeners) {
    try {
      listener(keys);
    } catch {
      // Seeded-height listeners are lifecycle hooks and must not break caching.
    }
  }
}

export function subscribeNodeHeightCacheSeeded(listener: (keys: string[] | null) => void): () => void {
  nodeHeightCacheSeededListeners.add(listener);
  return () => {
    nodeHeightCacheSeededListeners.delete(listener);
  };
}

export function getNodeHeightCacheSizeForTest(): number {
  return nodeHeightCache.size;
}

export function getNodeHeightCacheStatsForTest(): {
  size: number;
  widthSize: number;
  limit: number;
} {
  return {
    size: nodeHeightCache.size,
    widthSize: nodeWidthCache.size,
    limit: NODE_HEIGHT_CACHE_LIMIT,
  };
}

export function clearNodeHeightCache(): void {
  nodeHeightCache.clear();
  nodeWidthCache.clear();
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__marivellNodeHeightCacheSize =
      nodeHeightCache.size;
  }
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
