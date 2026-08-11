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
const HYDRATION_BATCH_SIZE = 128;
const IO_HYDRATION_PRIORITY = 10;
const DEFAULT_IO_OBSERVATION_LIMIT = 1000;

const virtualNodes = new Map<string, VirtualNodeRegistration>();
const virtualNodesByPositionDirty = new Set<string>();
let virtualNodeElements = new WeakMap<HTMLElement, string>();
interface PendingActivation {
  activate: () => void;
  isActive: () => boolean;
}

const pendingActivations = new Map<string, PendingActivation>();
const hydrationQueue = createHydrationQueue();
let virtualNodeObserver: IntersectionObserver | null = null;
let pendingActivationFrame: number | null = null;
let hydrationFrame: number | null = null;
let scrollAnchorProvider: ScrollAnchorProvider | null = null;

export interface ExternalHydrationTarget {
  getPosition: () => number;
  isActive: () => boolean;
  activate: () => void;
}

export interface ExternalIoCandidate {
  id: string;
  element: HTMLElement;
  position: number;
}

const externalIoElements = new Map<HTMLElement, string>();
const externalTargetElements = new Map<string, HTMLElement>();
const externalHydrationTargets = new Map<string, ExternalHydrationTarget>();
const ioObservedElements = new Set<HTMLElement>();
let ioEnabled = true;
let ioObservationLimit = DEFAULT_IO_OBSERVATION_LIMIT;
let ioDiagnostics: {
  callbackEntries: number;
  intersectingEntries: number;
  activeSkipEntries: number;
  missingTargetEntries: number;
  enqueuedEntries: number;
  callbackMsTotal: number;
  callbackMsMax: number;
  syncCount: number;
  lastSyncObserved: number;
} = {
  callbackEntries: 0,
  intersectingEntries: 0,
  activeSkipEntries: 0,
  missingTargetEntries: 0,
  enqueuedEntries: 0,
  callbackMsTotal: 0,
  callbackMsMax: 0,
  syncCount: 0,
  lastSyncObserved: 0,
};

let forceHydrateAllInlineMathGroups: (() => number) | null = null;

export function setForceHydrateAllInlineMathGroups(
  fn: (() => number) | null,
): void {
  forceHydrateAllInlineMathGroups = fn;
}

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

interface VirtualNodePositionEntry {
  id: string;
  position: number;
  priority: number;
  left: VirtualNodePositionEntry | null;
  right: VirtualNodePositionEntry | null;
  size: number;
}

let virtualNodePositionTree: VirtualNodePositionEntry | null = null;
const virtualNodePositionIndex = new Map<string, VirtualNodePositionEntry>();
let virtualNodePositionCount = 0;

interface VirtualNodePositionIndexTestCounters {
  registers: number;
  unregisters: number;
  dirtyFlushes: number;
  dirtyEntriesSeen: number;
  rangeQueries: number;
  fullScans: number;
  hydrateTargetRangeCalls: number;
}

const virtualNodePositionIndexTestCounters: VirtualNodePositionIndexTestCounters = {
  registers: 0,
  unregisters: 0,
  dirtyFlushes: 0,
  dirtyEntriesSeen: 0,
  rangeQueries: 0,
  fullScans: 0,
  hydrateTargetRangeCalls: 0,
};

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

function getVirtualNodePositionPriority(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

function updateVirtualNodePositionEntrySize(entry: VirtualNodePositionEntry): void {
  entry.size = 1 + (entry.left?.size ?? 0) + (entry.right?.size ?? 0);
}

function compareVirtualNodePositionEntries(
  left: VirtualNodePositionEntry,
  right: VirtualNodePositionEntry,
): number {
  if (left.position !== right.position) {
    return left.position - right.position;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function rotateVirtualNodePositionRight(root: VirtualNodePositionEntry): VirtualNodePositionEntry {
  const pivot = root.left!;
  root.left = pivot.right;
  pivot.right = root;
  updateVirtualNodePositionEntrySize(root);
  updateVirtualNodePositionEntrySize(pivot);
  return pivot;
}

function rotateVirtualNodePositionLeft(root: VirtualNodePositionEntry): VirtualNodePositionEntry {
  const pivot = root.right!;
  root.right = pivot.left;
  pivot.left = root;
  updateVirtualNodePositionEntrySize(root);
  updateVirtualNodePositionEntrySize(pivot);
  return pivot;
}

function insertVirtualNodePositionEntry(
  root: VirtualNodePositionEntry | null,
  entry: VirtualNodePositionEntry,
): VirtualNodePositionEntry {
  if (root === null) {
    entry.left = null;
    entry.right = null;
    entry.size = 1;
    return entry;
  }

  if (compareVirtualNodePositionEntries(entry, root) < 0) {
    root.left = insertVirtualNodePositionEntry(root.left, entry);
    if (root.left!.priority > root.priority) {
      root = rotateVirtualNodePositionRight(root);
    }
  } else {
    root.right = insertVirtualNodePositionEntry(root.right, entry);
    if (root.right!.priority > root.priority) {
      root = rotateVirtualNodePositionLeft(root);
    }
  }

  updateVirtualNodePositionEntrySize(root);
  return root;
}

function removeVirtualNodePositionEntry(
  root: VirtualNodePositionEntry | null,
  position: number,
  id: string,
): VirtualNodePositionEntry | null {
  if (root === null) {
    return null;
  }

  const comparison = position !== root.position
    ? position - root.position
    : id < root.id
      ? -1
      : id > root.id
        ? 1
        : 0;
  if (comparison < 0) {
    root.left = removeVirtualNodePositionEntry(root.left, position, id);
  } else if (comparison > 0) {
    root.right = removeVirtualNodePositionEntry(root.right, position, id);
  } else {
    return mergeVirtualNodePositionEntries(root.left, root.right);
  }

  updateVirtualNodePositionEntrySize(root);
  return root;
}

function mergeVirtualNodePositionEntries(
  left: VirtualNodePositionEntry | null,
  right: VirtualNodePositionEntry | null,
): VirtualNodePositionEntry | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  if (left.priority > right.priority) {
    left.right = mergeVirtualNodePositionEntries(left.right, right);
    updateVirtualNodePositionEntrySize(left);
    return left;
  }
  right.left = mergeVirtualNodePositionEntries(left, right.left);
  updateVirtualNodePositionEntrySize(right);
  return right;
}

function removeVirtualNodePosition(id: string): void {
  const entry = virtualNodePositionIndex.get(id);
  if (!entry) {
    return;
  }
  virtualNodePositionIndex.delete(id);
  virtualNodePositionTree = removeVirtualNodePositionEntry(
    virtualNodePositionTree,
    entry.position,
    id,
  );
  virtualNodePositionCount -= 1;
}

function insertVirtualNodePosition(id: string, position: number): void {
  const existing = virtualNodePositionIndex.get(id);
  if (existing?.position === position) {
    return;
  }
  if (existing) {
    removeVirtualNodePosition(id);
  }
  const entry: VirtualNodePositionEntry = {
    id,
    position,
    priority: getVirtualNodePositionPriority(id),
    left: null,
    right: null,
    size: 1,
  };
  virtualNodePositionIndex.set(id, entry);
  virtualNodePositionTree = insertVirtualNodePositionEntry(virtualNodePositionTree, entry);
  virtualNodePositionCount += 1;
}

function refreshVirtualNodePosition(id: string): void {
  const registration = virtualNodes.get(id);
  virtualNodesByPositionDirty.delete(id);
  if (!registration) {
    removeVirtualNodePosition(id);
    return;
  }
  const position = registration.getPosition?.() ?? null;
  if (position === null) {
    removeVirtualNodePosition(id);
    return;
  }
  insertVirtualNodePosition(id, position);
}

function collectVirtualNodePositionRange(
  root: VirtualNodePositionEntry | null,
  low: number,
  high: number,
  entries: Array<{ id: string; position: number }>,
): void {
  if (root === null) {
    return;
  }
  if (root.position > low) {
    collectVirtualNodePositionRange(root.left, low, high, entries);
  }
  if (root.position >= low && root.position <= high) {
    entries.push({ id: root.id, position: root.position });
  }
  if (root.position < high) {
    collectVirtualNodePositionRange(root.right, low, high, entries);
  }
}

function getVirtualNodePositionEntriesInRange(
  centerPosition: number,
  maxDistance: number,
): Array<{ id: string; position: number }> {
  virtualNodePositionIndexTestCounters.rangeQueries += 1;
  if (virtualNodePositionTree === null) {
    return [];
  }
  const low = centerPosition - maxDistance;
  const high = centerPosition + maxDistance;
  const entries: Array<{ id: string; position: number }> = [];
  collectVirtualNodePositionRange(virtualNodePositionTree, low, high, entries);
  return entries;
}

function flushVirtualNodePositionDirty(): void {
  if (virtualNodesByPositionDirty.size === 0) {
    return;
  }
  virtualNodePositionIndexTestCounters.dirtyFlushes += 1;
  virtualNodePositionIndexTestCounters.dirtyEntriesSeen += virtualNodesByPositionDirty.size;
  for (const id of Array.from(virtualNodesByPositionDirty)) {
    refreshVirtualNodePosition(id);
  }
}

function flushPendingActivations(): void {
  pendingActivationFrame = null;
  flushVirtualNodePositionDirty();
  if (pendingActivations.size === 0) {
    return;
  }

  const anchor = scrollAnchorProvider?.capture() ?? null;
  try {
    const ids = Array.from(pendingActivations.keys()).slice(0, VIRTUAL_ACTIVATION_BATCH_SIZE);
    for (const id of ids) {
      const pending = pendingActivations.get(id);
      pendingActivations.delete(id);
      if (!pending || pending.isActive()) {
        continue;
      }

      const registration = virtualNodes.get(id);
      if (registration) {
        registration.active = true;
        registration.state = 'active';
      }
      pending.activate();
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

function unobservePlaceholderElement(element: HTMLElement): void {
  virtualNodeObserver?.unobserve(element);
  ioObservedElements.delete(element);
}

function enqueueIoPlaceholder(
  id: string,
  position: number,
  activate: () => void,
  isActive: () => boolean,
): void {
  hydrationQueue.enqueue({
    id,
    position,
    priority: IO_HYDRATION_PRIORITY,
  });
  ioDiagnostics.enqueuedEntries += 1;
  if (!pendingActivations.has(id) && !isActive()) {
    pendingActivations.set(id, { activate, isActive });
    schedulePendingActivationFlush();
  }
}

function processPlaceholderIoEntries(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    const element = entry.target as HTMLElement | null;
    if (!element) {
      continue;
    }
    const virtualId = virtualNodeElements.get(element);
    const externalId = externalIoElements.get(element);
    const id = virtualId ?? externalId;
    if (id === undefined) {
      unobservePlaceholderElement(element);
      ioDiagnostics.missingTargetEntries += 1;
      continue;
    }

    ioDiagnostics.callbackEntries += 1;
    const callbackStart = performance.now();
    if (!entry.isIntersecting) {
      cancelPendingActivation(id);
      ioDiagnostics.callbackMsTotal += performance.now() - callbackStart;
      ioDiagnostics.callbackMsMax = Math.max(
        ioDiagnostics.callbackMsMax,
        performance.now() - callbackStart,
      );
      continue;
    }

    const registration = virtualNodes.get(id);
    if (registration) {
      if (registration.active) {
        unobservePlaceholderElement(element);
        ioDiagnostics.activeSkipEntries += 1;
        ioDiagnostics.callbackMsTotal += performance.now() - callbackStart;
        ioDiagnostics.callbackMsMax = Math.max(
          ioDiagnostics.callbackMsMax,
          performance.now() - callbackStart,
        );
        continue;
      }
      registration.forceActive = false;
      registration.state = 'pending';
      enqueueIoPlaceholder(
        id,
        registration.getPosition?.() ?? 0,
        registration.activate,
        () => registration.active,
      );
      ioDiagnostics.callbackMsTotal += performance.now() - callbackStart;
      ioDiagnostics.callbackMsMax = Math.max(
        ioDiagnostics.callbackMsMax,
        performance.now() - callbackStart,
      );
      continue;
    }

    const external = externalHydrationTargets.get(id);
    if (!external || external.isActive()) {
      unobservePlaceholderElement(element);
      ioDiagnostics.activeSkipEntries += 1;
      ioDiagnostics.callbackMsTotal += performance.now() - callbackStart;
      ioDiagnostics.callbackMsMax = Math.max(
        ioDiagnostics.callbackMsMax,
        performance.now() - callbackStart,
      );
      continue;
    }
    ioDiagnostics.intersectingEntries += 1;
    enqueueIoPlaceholder(
      id,
      external.getPosition(),
      external.activate,
      () => external.isActive(),
    );
    ioDiagnostics.callbackMsTotal += performance.now() - callbackStart;
    ioDiagnostics.callbackMsMax = Math.max(
      ioDiagnostics.callbackMsMax,
      performance.now() - callbackStart,
    );
  }
}

function getVirtualNodeObserver(rootElement?: HTMLElement | null): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') {
    return null;
  }

  const resolvedRoot =
    rootElement ??
    (typeof document !== 'undefined'
      ? document.querySelector<HTMLElement>('.editor-frame') ?? null
      : null);
  if (virtualNodeObserver !== null && virtualNodeObserver.root !== resolvedRoot) {
    virtualNodeObserver.disconnect();
    virtualNodeObserver = null;
    ioObservedElements.clear();
  }

  if (virtualNodeObserver === null) {
    const viewportHeight =
      resolvedRoot?.clientHeight ??
      (typeof window !== 'undefined'
        ? window.innerHeight || document.documentElement.clientHeight || 800
        : 800);
    const rootMargin = Math.max(10_000, Math.ceil(viewportHeight * 10));
    virtualNodeObserver = new IntersectionObserver((entries) => {
      processPlaceholderIoEntries(entries);
    }, {
      root: resolvedRoot,
      rootMargin: `${rootMargin}px 0px ${rootMargin}px 0px`,
    });
  }

  return virtualNodeObserver;
}

export function registerIoPlaceholder(
  element: HTMLElement,
  id: string,
  target: ExternalHydrationTarget,
): () => void {
  unregisterIoPlaceholder(id);
  const previousId = externalIoElements.get(element);
  if (previousId !== undefined && previousId !== id) {
    unregisterIoPlaceholder(previousId);
  }
  externalIoElements.set(element, id);
  externalTargetElements.set(id, element);
  externalHydrationTargets.set(id, target);
  return () => unregisterIoPlaceholder(id);
}

export function unregisterIoPlaceholder(id: string): void {
  const element = externalTargetElements.get(id);
  if (element) {
    unobservePlaceholderElement(element);
    externalIoElements.delete(element);
  }
  externalTargetElements.delete(id);
  externalHydrationTargets.delete(id);
  cancelPendingActivation(id);
}

export function syncPlaceholderIo(
  frame: HTMLElement,
  centerPosition: number,
  candidateRadius: number,
  externalCandidates: ExternalIoCandidate[] = [],
): number {
  void frame;
  ioDiagnostics.syncCount += 1;
  if (!ioEnabled || typeof IntersectionObserver === 'undefined') {
    return 0;
  }
  const observer = getVirtualNodeObserver(frame);
  if (observer === null || ioObservationLimit <= 0) {
    return 0;
  }

  const finiteRadius = Number.isFinite(candidateRadius) && candidateRadius > 0
    ? candidateRadius
    : Math.max(1, candidateRadius);
  const candidates: Array<{ element: HTMLElement; id: string; position: number }> = [];
  flushVirtualNodePositionDirty();
  for (const entry of getVirtualNodePositionEntriesInRange(
    centerPosition,
    finiteRadius,
  )) {
    const registration = virtualNodes.get(entry.id);
    if (
      registration &&
      !registration.active &&
      registration.element.isConnected
    ) {
      candidates.push({
        element: registration.element,
        id: registration.id,
        position: entry.position,
      });
    }
  }
  for (const candidate of externalCandidates) {
    const target = externalHydrationTargets.get(candidate.id);
    if (
      target &&
      !target.isActive() &&
      candidate.element.isConnected
    ) {
      candidates.push({
        element: candidate.element,
        id: candidate.id,
        position: candidate.position,
      });
    }
  }

  candidates.sort(
    (left, right) =>
      Math.abs(left.position - centerPosition) -
      Math.abs(right.position - centerPosition),
  );
  const selected = candidates.slice(0, ioObservationLimit);
  const selectedElements = new Set(selected.map((candidate) => candidate.element));
  for (const element of Array.from(ioObservedElements)) {
    if (!selectedElements.has(element) || !element.isConnected) {
      unobservePlaceholderElement(element);
    }
  }

  let observed = 0;
  for (const candidate of selected) {
    if (ioObservedElements.has(candidate.element)) {
      observed += 1;
      continue;
    }
    observer.observe(candidate.element);
    ioObservedElements.add(candidate.element);
    observed += 1;
  }
  ioDiagnostics.lastSyncObserved = observed;
  return observed;
}

export function setIoObservationLimitForTest(limit: number): void {
  ioObservationLimit = Math.max(0, Math.floor(limit));
}

export function setIoEnabledForTest(enabled: boolean): void {
  ioEnabled = enabled;
  if (enabled) {
    return;
  }
  for (const element of Array.from(ioObservedElements)) {
    unobservePlaceholderElement(element);
  }
  pendingActivations.clear();
  hydrationQueue.clear();
  if (pendingActivationFrame !== null) {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(pendingActivationFrame);
    }
    pendingActivationFrame = null;
  }
}

export function getIoDiagnosticsForTest(): {
  enabled: boolean;
  observationLimit: number;
  observedCount: number;
  observerCount: number;
  observerRoot: string | null;
  callbackEntries: number;
  intersectingEntries: number;
  activeSkipEntries: number;
  missingTargetEntries: number;
  enqueuedEntries: number;
  callbackMsTotal: number;
  callbackMsMax: number;
  syncCount: number;
  lastSyncObserved: number;
} {
  return {
    enabled: ioEnabled,
    observationLimit: ioObservationLimit,
    observedCount: ioObservedElements.size,
    observerCount: virtualNodeObserver === null ? 0 : 1,
    observerRoot:
      virtualNodeObserver?.root instanceof Element
        ? virtualNodeObserver.root.className
        : virtualNodeObserver?.root === null
          ? 'viewport'
          : null,
    callbackEntries: ioDiagnostics.callbackEntries,
    intersectingEntries: ioDiagnostics.intersectingEntries,
    activeSkipEntries: ioDiagnostics.activeSkipEntries,
    missingTargetEntries: ioDiagnostics.missingTargetEntries,
    enqueuedEntries: ioDiagnostics.enqueuedEntries,
    callbackMsTotal: ioDiagnostics.callbackMsTotal,
    callbackMsMax: ioDiagnostics.callbackMsMax,
    syncCount: ioDiagnostics.syncCount,
    lastSyncObserved: ioDiagnostics.lastSyncObserved,
  };
}

export function resetIoDiagnosticsForTest(): void {
  ioDiagnostics = {
    callbackEntries: 0,
    intersectingEntries: 0,
    activeSkipEntries: 0,
    missingTargetEntries: 0,
    enqueuedEntries: 0,
    callbackMsTotal: 0,
    callbackMsMax: 0,
    syncCount: 0,
    lastSyncObserved: 0,
  };
}

if (typeof window !== 'undefined') {
  const benchmarkWindow = window as unknown as Record<string, unknown>;
  benchmarkWindow.__marivellSetIoEnabled = setIoEnabledForTest;
  benchmarkWindow.__marivellSetIoObservationLimit =
    setIoObservationLimitForTest;
  benchmarkWindow.__marivellGetIoDiagnostics = getIoDiagnosticsForTest;
  benchmarkWindow.__marivellResetIoDiagnostics = resetIoDiagnosticsForTest;
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
  unobservePlaceholderElement(registration.element);
  virtualNodesByPositionDirty.delete(id);
  removeVirtualNodePosition(id);
  virtualNodePositionIndexTestCounters.unregisters += 1;
}

export function resetActivationControllerForTest(): void {
  virtualNodeObserver?.disconnect();
  virtualNodeObserver = null;
  virtualNodes.clear();
  virtualNodePositionTree = null;
  virtualNodePositionIndex.clear();
  virtualNodePositionCount = 0;
  virtualNodesByPositionDirty.clear();
  virtualNodePositionIndexTestCounters.registers = 0;
  virtualNodePositionIndexTestCounters.unregisters = 0;
  virtualNodePositionIndexTestCounters.dirtyFlushes = 0;
  virtualNodePositionIndexTestCounters.dirtyEntriesSeen = 0;
  virtualNodePositionIndexTestCounters.rangeQueries = 0;
  virtualNodePositionIndexTestCounters.fullScans = 0;
  virtualNodePositionIndexTestCounters.hydrateTargetRangeCalls = 0;
  virtualNodeElements = new WeakMap<HTMLElement, string>();
  externalIoElements.clear();
  externalTargetElements.clear();
  externalHydrationTargets.clear();
  ioObservedElements.clear();
  ioEnabled = true;
  ioObservationLimit = DEFAULT_IO_OBSERVATION_LIMIT;
  ioDiagnostics = {
    callbackEntries: 0,
    intersectingEntries: 0,
    activeSkipEntries: 0,
    missingTargetEntries: 0,
    enqueuedEntries: 0,
    callbackMsTotal: 0,
    callbackMsMax: 0,
    syncCount: 0,
    lastSyncObserved: 0,
  };
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
  const previousElementId = virtualNodeElements.get(element);
  if (previousElementId !== undefined) {
    unregisterVirtualNodeView(previousElementId);
  }
  const previous = virtualNodes.get(id);
  if (previous && previous.element !== element) {
    unregisterVirtualNodeView(id);
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
  virtualNodesByPositionDirty.add(id);
  virtualNodePositionIndexTestCounters.registers += 1;

  if (typeof IntersectionObserver === 'undefined') {
    registration.active = true;
    registration.state = 'active';
    registration.activate();
  } else if (ioEnabled) {
    const root = element.closest<HTMLElement>('.editor-frame') ?? null;
    getVirtualNodeObserver(root)?.observe(element);
    ioObservedElements.add(element);
  }

  return () => unregisterVirtualNodeView(id);
}

export function forceActivate(id: string): void {
  const registration = virtualNodes.get(id);
  if (!registration) {
    cancelPendingActivation(id);
    return;
  }

  unobservePlaceholderElement(registration.element);
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

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__marivellForceActivateById = forceActivateById;
}

export function forceHydrateAll(): number {
  return withScrollAnchorRestore(() => {
    let activatedCount = 0;
    if (typeof window !== 'undefined') {
      const benchmarkWindow = window as unknown as {
        markdownEditor?: { getBenchmarkEnabled?: () => boolean };
        __marivellForceHydrateAllCalls?: number;
      };
      if (benchmarkWindow.markdownEditor?.getBenchmarkEnabled?.()) {
        benchmarkWindow.__marivellForceHydrateAllCalls =
          (benchmarkWindow.__marivellForceHydrateAllCalls ?? 0) + 1;
      }
    }

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

    forceHydrateAllInlineMathGroups?.();
    for (const id of Array.from(pendingActivations.keys())) {
      cancelPendingActivation(id);
    }
    return activatedCount;
  });
}

export function forceDeactivateAllVirtualNodes(): number {
  let deactivatedCount = 0;
  for (const [id, registration] of Array.from(virtualNodes)) {
    cancelPendingActivation(id);
    registration.forceActive = false;
    if (registration.active) {
      registration.active = false;
      registration.state = 'placeholder';
      registration.deactivate();
      deactivatedCount += 1;
    } else if (registration.nodeType === 'inlineMath') {
      registration.state = 'placeholder';
      registration.deactivate();
    }
  }
  if (pendingActivations.size === 0 && pendingActivationFrame !== null) {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(pendingActivationFrame);
    }
    pendingActivationFrame = null;
  }
  return deactivatedCount;
}

export function forceActivateViewport(container: HTMLElement, rootMargin = 800): number {
  if (typeof IntersectionObserver === 'undefined') {
    return 0;
  }
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

export function getVirtualNodePositionIndexSizeForTest(): number {
  flushVirtualNodePositionDirty();
  return virtualNodePositionCount;
}

export function getVirtualNodePositionIndexTestCountersForTest(): VirtualNodePositionIndexTestCounters {
  return { ...virtualNodePositionIndexTestCounters };
}

export function hydrateTargetRange(
  frame: HTMLElement,
  centerPosition: number,
  radius: number,
  includeAllVirtualNodes = false,
  drainQueue = false,
): number {
  virtualNodePositionIndexTestCounters.hydrateTargetRangeCalls += 1;
  if (typeof window !== 'undefined') {
    const benchmarkWindow = window as unknown as {
      markdownEditor?: { getBenchmarkEnabled?: () => boolean };
      __marivellHydrateTargetRangeCalls?: number;
    };
    if (benchmarkWindow.markdownEditor?.getBenchmarkEnabled?.()) {
      benchmarkWindow.__marivellHydrateTargetRangeCalls =
        (benchmarkWindow.__marivellHydrateTargetRangeCalls ?? 0) + 1;
    }
  }
  const viewportRadius = Number.isFinite(radius) && radius > 0
    ? radius
    : Math.max(frame.clientHeight || 1, 1);
  const activationRadius = viewportRadius * 1.5;
  const prefetchRadius = viewportRadius * 3;
  const evictRadius = prefetchRadius;

  hydrationQueue.evictOutside(evictRadius, centerPosition);
  flushVirtualNodePositionDirty();
  const scanStart = performance.now();
  let scanned = 0;

  const candidates = getVirtualNodePositionEntriesInRange(centerPosition, evictRadius);

  for (const candidate of candidates) {
    const registration = virtualNodes.get(candidate.id);
    if (!registration) {
      continue;
    }
    const position = candidate.position;
    scanned += 1;

    const distance = Math.abs(position - centerPosition);
    if (distance > evictRadius) {
      cancelPendingActivation(registration.id);
      continue;
    }
    if (distance > prefetchRadius || registration.active) {
      continue;
    }
    if (
      !includeAllVirtualNodes &&
      (registration.nodeType === 'image' ||
        registration.nodeType === 'mermaidBlock' ||
        registration.nodeType === 'htmlBlock' ||
        registration.nodeType === 'codeBlock')
    ) {
      continue;
    }

    if (distance <= activationRadius) {
      const activationStart = performance.now();
      forceActivate(registration.id);
      if (typeof window !== 'undefined') {
        const profile = (window as unknown as Record<string, unknown>).__marivellHydrateActivateProfile;
        if (Array.isArray(profile)) {
          profile.push({
            id: registration.id,
            nodeType: registration.nodeType,
            ms: performance.now() - activationStart,
          });
        } else {
          (window as unknown as Record<string, unknown>).__marivellHydrateActivateProfile = [{
            id: registration.id,
            nodeType: registration.nodeType,
            ms: performance.now() - activationStart,
          }];
        }
      }
    } else {
      hydrationQueue.enqueue({
        id: registration.id,
        position,
        priority: 0,
      });
    }
  }

  const activateStart = performance.now();
  let activatedCount = 0;
  let drainedTasks = 0;
  const queueSizeBefore = hydrationQueue.size;
  const drainRadius = drainQueue ? activationRadius : prefetchRadius;

  const batchLimit = drainQueue ? Number.MAX_SAFE_INTEGER : HYDRATION_BATCH_SIZE;
  while (activatedCount < batchLimit) {
    const task = hydrationQueue.next(centerPosition);
    if (task === null) {
      break;
    }
    if (Math.abs(task.position - centerPosition) > drainRadius) {
      if (drainQueue) {
        hydrationQueue.enqueue({
          id: task.id,
          position: task.position,
          priority: task.priority,
        });
        break;
      }
      continue;
    }
    drainedTasks += 1;
    const registration = virtualNodes.get(task.id);
    if (!registration) {
      const external = externalHydrationTargets.get(task.id);
      if (!external || external.isActive()) {
        continue;
      }
      external.activate();
      activatedCount += 1;
      continue;
    }
    if (registration.active) {
      continue;
    }

    const activationStart = performance.now();
    forceActivate(task.id);
    activatedCount += 1;
    if (typeof window !== 'undefined') {
      const profile = (window as unknown as Record<string, unknown>).__marivellHydrateActivateProfile;
      const entry = {
        id: task.id,
        nodeType: registration.nodeType,
        ms: performance.now() - activationStart,
      };
      if (Array.isArray(profile)) {
        profile.push(entry);
      } else {
        (window as unknown as Record<string, unknown>).__marivellHydrateActivateProfile = [entry];
      }
    }
  }

  // The caller's radius is already 1.5x the viewport; 2x keeps IO at +/-3 viewports.
  syncPlaceholderIo(frame, centerPosition, viewportRadius * 2);

  if (!drainQueue && hydrationQueue.size > 0 && hydrationFrame === null) {
    hydrationFrame = requestAnimationFrame(() => {
      hydrationFrame = null;
      hydrateTargetRange(frame, centerPosition, radius);
    });
  }

  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__marivellPhase4HydrateTimings = {
      scanMs: performance.now() - scanStart,
      activateMs: performance.now() - activateStart,
      queueSizeBefore,
      queueSizeAfter: hydrationQueue.size,
      drainedTasks,
      drainRadius,
      scanned,
      activated: activatedCount,
    };
  }

  return activatedCount;
}
