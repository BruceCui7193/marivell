export type ImagePreloadState = 'loading' | 'ready' | 'failed';

interface ImagePreloadEntry {
  promise: Promise<void>;
  state: ImagePreloadState;
}

const imagePreloadCache = new Map<string, ImagePreloadEntry>();
const IMAGE_PRELOAD_CACHE_LIMIT = 200;

function cacheImagePreload(src: string, entry: ImagePreloadEntry): void {
  imagePreloadCache.delete(src);
  imagePreloadCache.set(src, entry);

  if (imagePreloadCache.size <= IMAGE_PRELOAD_CACHE_LIMIT) {
    return;
  }

  const oldestKey = imagePreloadCache.keys().next().value;
  if (typeof oldestKey === 'string') {
    imagePreloadCache.delete(oldestKey);
  }
}

export function preloadImageSource(src: string): Promise<void> {
  const cached = imagePreloadCache.get(src);
  if (cached) {
    cacheImagePreload(src, cached);
    return cached.promise;
  }

  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  const entry: ImagePreloadEntry = { promise, state: 'loading' };
  cacheImagePreload(src, entry);

  const complete = (state: ImagePreloadState): void => {
    if (entry.state !== 'loading') {
      return;
    }
    entry.state = state;
    resolvePromise?.();
  };

  if (typeof Image === 'undefined') {
    complete('failed');
    return promise;
  }

  try {
    const image = new Image();
    image.onload = () => complete('ready');
    image.onerror = () => complete('failed');
    image.src = src;

    if (image.complete) {
      queueMicrotask(() => complete('ready'));
    }
  } catch {
    complete('failed');
  }

  return promise;
}

export function getImagePreloadState(src: string): ImagePreloadState | null {
  return imagePreloadCache.get(src)?.state ?? null;
}

export function clearImagePreloadCache(): void {
  imagePreloadCache.clear();
}
