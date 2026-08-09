import { createHydrationQueue } from './hydration-queue';

interface VirtualNodeCallbacks {
  activate(): void;
  deactivate(): void;
  shouldDeactivate?(): boolean;
}

export type VirtualNodeState = 'placeholder' | 'pending' | 'active';

export interface VirtualNodeMetadata {
  nodeType?: string;
  contentHash?: string | (() => string | null);
  heightKey?: string | (() => string | null);
  getPosition?: () => number | null;
}

interface VirtualNodeRegistration extends VirtualNodeCallbacks, VirtualNodeMetadata {
  id: string;
  element: HTMLElement;
  active: boolean;
  forceActive: boolean;
  state: VirtualNodeState;
}

export interface ScrollAnchorSnapshot {
  pmPos: number;
  offsetTop: number;
  scrollTop?: number;
}

export interface ScrollAnchorProvider {
  capture(): ScrollAnchorSnapshot | null;
  restore(anchor: ScrollAnchorSnapshot): void;
}

export const VIRTUAL_ACTIVATION_BATCH_SIZE = 24;
const HYDRATION_BATCH_SIZE = 64;

const virtualNodes = new Map<string, VirtualNodeRegistration>();
let virtualNodeElements = new WeakMap<HTMLElement, string>();
const pendingActivations = new Map<string, VirtualNodeRegistration>();
const hydrationQueue = createHydrationQueue();
let virtualNodeObserver: IntersectionObserver | null = null;
let pendingActivationFrame: number | null = null;
let hydrationFrame: number | null = null;
let scrollAnchorProvider: ScrollAnchorProvider | null = null;

export function setScrollAnchorProvider(provider: ScrollAnchorProvider | null): void {
  scrollAnchorProvider = provider;
}

let suspendedScrollAnchorProvider: ScrollAnchorProvider | null = null;

export function suspendScrollAnchorProvider(): void {
  if (scrollAnchorProvider !== null) {
    suspendedScrollAnchorProvider = scrollAnchorProvider;
    scrollAnchorProvider = null;
  }
}

export function resumeScrollAnchorProvider(): void {
  if (suspendedScrollAnchorProvider !== null) {
    scrollAnchorProvider = suspendedScrollAnchorProvider;
    suspendedScrollAnchorProvider = null;
  }
}



function withScrollAnchorRestore<T>(operation: () => T): T {
  const anchor = scrollAnchorProvider?.capture() ?? null;
  try {
    return operation();
  } finally {
    if (anchor !== null) {
      scrollAnchorProvider?.restore(anchor);
    }
  }
}

function flushPendingActivations(): void {
  pendingActivationFrame = null;
  if (pendingActivations.size === 0) {
    return;
  }

  const anchor = scrollAnchorProvider?.capture() ?? null;
  try {
    const ids = Array.from(pendingActivations.keys()).slice(0, VIRTUAL_ACTIVATION_BATCH_SIZE);
    for (const id of ids) {
      const registration = pendingActivations.get(id);
      pendingActivations.delete(id);
      if (!registration || registration.active) {
        continue;
      }

      registration.active = true;
      registration.state = 'active';
      registration.activate();
    }
  } finally {
    if (anchor !== null) {
      scrollAnchorProvider?.restore(anchor);
    }
  }

  if (pendingActivations.size > 0) {
    schedulePendingActivationFlush();
  }
}

function schedulePendingActivationFlush(): void {
  if (pendingActivationFrame !== null || pendingActivations.size === 0) {
    return;
  }

  if (typeof requestAnimationFrame === 'undefined') {
    flushPendingActivations();
    return;
  }

  pendingActivationFrame = requestAnimationFrame(flushPendingActivations);
}

function cancelPendingActivation(id: string): void {
  if (pendingActivations.delete(id)) {
    const registration = virtualNodes.get(id);
    if (registration?.state === 'pending') {
      registration.state = 'placeholder';
    }
  }
}

function processVirtualNodeEntries(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    const element = entry.target as HTMLElement | null;
    const id = element === null ? null : virtualNodeElements.get(element) ?? null;
    const registration = id === null ? undefined : virtualNodes.get(id);
    if (!registration || id === null) {
      continue;
    }

    if (entry.isIntersecting) {
      registration.forceActive = false;
      const viewportHeight =
        typeof window !== 'undefined'
          ? window.innerHeight || document.documentElement.clientHeight || 0
          : 0;
      const rect = entry.boundingClientRect;
      const visibleNow = rect !== undefined && rect.bottom > 0 && rect.top < viewportHeight;
      if (visibleNow) {
        if (!registration.active) {
          registration.active = true;
          registration.state = 'active';
          registration.activate();
        }
      } else if (!registration.active && !pendingActivations.has(id)) {
        registration.state = 'pending';
        pendingActivations.set(id, registration);
        schedulePendingActivationFlush();
      }
    } else {
      cancelPendingActivation(id);
      if (registration.active && !registration.forceActive && registration.shouldDeactivate?.() !== false) {
        registration.active = false;
        registration.state = 'placeholder';
        registration.deactivate();
      }
    }
  }
}

function getVirtualNodeObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') {
    return null;
  }

  if (virtualNodeObserver === null) {
    virtualNodeObserver = new IntersectionObserver((entries) => {
      processVirtualNodeEntries(entries);
    }, { rootMargin: '1600px' });
  }

  return virtualNodeObserver;
}

function unregisterVirtualNodeView(id: string): void {
  const registration = virtualNodes.get(id);
  if (!registration) {
    cancelPendingActivation(id);
    return;
  }

  cancelPendingActivation(id);
  if (registration.element.dataset.virtualNodeId === id) {
    delete registration.element.dataset.virtualNodeId;
  }
  virtualNodes.delete(id);
  virtualNodeElements.delete(registration.element);
  virtualNodeObserver?.unobserve(registration.element);
}

export function resetActivationControllerForTest(): void {
  virtualNodeObserver?.disconnect();
  virtualNodeObserver = null;
  virtualNodes.clear();
  virtualNodeElements = new WeakMap<HTMLElement, string>();
  pendingActivations.clear();
  hydrationQueue.clear();
  scrollAnchorProvider = null;
  suspendedScrollAnchorProvider = null;
  if (hydrationFrame !== null) {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(hydrationFrame);
    }
    hydrationFrame = null;
  }
  if (pendingActivationFrame !== null) {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(pendingActivationFrame);
    }
    pendingActivationFrame = null;
  }
}

export function registerVirtualNodeView(
  id: string,
  element: HTMLElement,
  callbacks: VirtualNodeCallbacks,
  metadata: VirtualNodeMetadata = {},
): () => void {
  for (const previous of Array.from(virtualNodes.values())) {
    if (previous.element !== element) {
      continue;
    }
    cancelPendingActivation(previous.id);
    virtualNodeObserver?.unobserve(previous.element);
    virtualNodeElements.delete(previous.element);
    virtualNodes.delete(previous.id);
    if (previous.element.dataset.virtualNodeId === previous.id) {
      delete previous.element.dataset.virtualNodeId;
    }
  }

  const previous = virtualNodes.get(id);
  if (previous) {
    cancelPendingActivation(id);
    virtualNodeObserver?.unobserve(previous.element);
    virtualNodeElements.delete(previous.element);
    if (previous.element.dataset.virtualNodeId === id) {
      delete previous.element.dataset.virtualNodeId;
    }
  }

  const registration: VirtualNodeRegistration = {
    id,
    element,
    active: false,
    forceActive: false,
    state: 'placeholder',
    ...metadata,
    activate: callbacks.activate,
    deactivate: callbacks.deactivate,
    shouldDeactivate: callbacks.shouldDeactivate,
  };
  virtualNodes.set(id, registration);
  virtualNodeElements.set(element, id);
  element.dataset.virtualNodeId = id;

  if (typeof IntersectionObserver === 'undefined') {
    registration.active = true;
    registration.state = 'active';
    registration.activate();
  } else {
    getVirtualNodeObserver()?.observe(element);
  }

  return () => unregisterVirtualNodeView(id);
}

export function forceActivate(id: string): void {
  const registration = virtualNodes.get(id);
  if (!registration) {
    cancelPendingActivation(id);
    return;
  }

  cancelPendingActivation(id);
  registration.forceActive = true;
  if (!registration.active) {
    registration.active = true;
    registration.state = 'active';
    registration.activate();
  } else if (registration.state === 'pending') {
    registration.state = 'active';
  }
}

export function forceActivateById(id: string): void {
  forceActivate(id);
}

export function forceHydrateAll(): number {
  return withScrollAnchorRestore(() => {
    let activatedCount = 0;

    for (const [id, registration] of Array.from(virtualNodes)) {
      cancelPendingActivation(id);
      if (!registration.active) {
        registration.active = true;
        registration.state = 'active';
        registration.activate();
        activatedCount += 1;
      } else if (registration.state === 'pending') {
        registration.state = 'active';
      }
    }

    if (pendingActivations.size === 0 && pendingActivationFrame !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(pendingActivationFrame);
      }
      pendingActivationFrame = null;
    }

    return activatedCount;
  });
}

export function forceActivateViewport(container: HTMLElement, rootMargin = 800): number {
  return withScrollAnchorRestore(() => {
    let activatedCount = 0;
    const containerRect = container.getBoundingClientRect();
    const top = containerRect.top - rootMargin;
    const bottom = containerRect.bottom + rootMargin;

    for (const registration of Array.from(virtualNodes.values())) {
      if (!registration.element.isConnected) {
        continue;
      }

      const elementRect = registration.element.getBoundingClientRect();
      if (elementRect.bottom < top || elementRect.top > bottom) {
        continue;
      }

      if (!registration.active) {
        forceActivate(registration.id);
      } else {
        registration.activate();
      }
      activatedCount += 1;
    }

    return activatedCount;
  });
}

export function hydrateVisibleAroundRatio(
  container: HTMLElement,
  scrollTop: number,
  maxScrollTop: number,
  windowRatio = 0.22,
): number {
  // Coarse ratio window avoids reading all 2400+ placeholder rects on every
  // large jump. The normal IntersectionObserver still covers any miss.
  const registrations = Array.from(virtualNodes.values());
  if (registrations.length === 0) {
    return 0;
  }

  const containerRect = container.getBoundingClientRect();
  const top = containerRect.top;
  const bottom = containerRect.bottom;
  const ratio = maxScrollTop > 0 ? Math.min(1, Math.max(0, scrollTop / maxScrollTop)) : 0;
  const centerIndex = Math.floor((registrations.length - 1) * ratio);
  const radius = Math.max(120, Math.floor(registrations.length * windowRatio));
  const from = Math.max(0, centerIndex - radius);
  const to = Math.min(registrations.length, centerIndex + radius + 1);
  const toActivate: string[] = [];

  for (let index = from; index < to; index += 1) {
    const registration = registrations[index];
    if (!registration.element.isConnected || registration.active) {
      continue;
    }
    const elementRect = registration.element.getBoundingClientRect();
    if (elementRect.bottom < top || elementRect.top > bottom) {
      continue;
    }
    toActivate.push(registration.id);
  }

  for (const id of toActivate) {
    forceActivate(id);
  }
  return toActivate.length;
}

export function hydrateTargetRange(
  frame: HTMLElement,
  centerPosition: number,
  radius: number,
): number {
  const viewportRadius = Number.isFinite(radius) && radius > 0
    ? radius
    : Math.max(frame.clientHeight || 1, 1);
  const prefetchRadius = viewportRadius * 2;
  const evictRadius = viewportRadius * 4;

  hydrationQueue.evictOutside(evictRadius, centerPosition);
  const scanStart = performance.now();
  let scanned = 0;

  for (const registration of Array.from(virtualNodes.values())) {
    const position = registration.getPosition?.() ?? null;
    scanned += 1;
    if (position === null) {
      continue;
    }

    const distance = Math.abs(position - centerPosition);
    if (distance > evictRadius) {
      cancelPendingActivation(registration.id);
      continue;
    }
    if (distance > prefetchRadius || registration.active) {
      continue;
    }

    hydrationQueue.enqueue({
      id: registration.id,
      position,
      priority: distance <= viewportRadius ? 1 : 0,
    });
  }

  const activateStart = performance.now();
  let activatedCount = 0;

  while (activatedCount < HYDRATION_BATCH_SIZE) {
    const task = hydrationQueue.next(centerPosition);
    if (task === null) {
      break;
    }
    if (Math.abs(task.position - centerPosition) > prefetchRadius) {
      continue;
    }
    const registration = virtualNodes.get(task.id);
    if (!registration || registration.active) {
      continue;
    }

    forceActivate(task.id);
    activatedCount += 1;
  }

  if (hydrationQueue.size > 0 && hydrationFrame === null) {
    hydrationFrame = requestAnimationFrame(() => {
      hydrationFrame = null;
      hydrateTargetRange(frame, centerPosition, radius);
    });
  }

  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__marivellPhase4HydrateTimings = {
      scanMs: performance.now() - scanStart,
      activateMs: performance.now() - activateStart,
      scanned,
      activated: activatedCount,
    };
  }

  return activatedCount;
}
