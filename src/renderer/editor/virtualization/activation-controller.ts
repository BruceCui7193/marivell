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

export const VIRTUAL_ACTIVATION_BATCH_SIZE = 24;

const virtualNodes = new Map<string, VirtualNodeRegistration>();
let virtualNodeElements = new WeakMap<HTMLElement, string>();
const pendingActivations = new Map<string, VirtualNodeRegistration>();
let virtualNodeObserver: IntersectionObserver | null = null;
let pendingActivationFrame: number | null = null;

function flushPendingActivations(): void {
  pendingActivationFrame = null;
  if (pendingActivations.size === 0) {
    return;
  }

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

function getVirtualNodeObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') {
    return null;
  }

  if (virtualNodeObserver === null) {
    virtualNodeObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement | null;
        const id = element === null ? null : virtualNodeElements.get(element) ?? null;
        const registration = id === null ? undefined : virtualNodes.get(id);
        if (!registration || id === null) {
          continue;
        }

        if (entry.isIntersecting) {
          registration.forceActive = false;
          if (!registration.active && !pendingActivations.has(id)) {
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
    }, { rootMargin: '800px' });
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
}

export function forceActivateViewport(container: HTMLElement, rootMargin = 800): number {
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
}
