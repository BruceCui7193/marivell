import { getCachedFormulaHtml, getFormulaCacheKey } from '../math-render-cache';
import {
  cloneFormulaTemplateContent,
  resetFormulaTemplateCacheForTest,
} from './formula-template-cache';
import type { FormulaIndexEntry } from '../markdown.worker';
import {
  getCachedNodeHeight,
  getCachedNodeWidth,
  notifyNodeHeightCacheSeeded,
  setCachedNodeHeight,
  subscribeNodeHeightCacheInvalidation,
  subscribeNodeHeightCacheSeeded,
} from './height-cache';
import {
  buildFormulaHeightMeasurementItems,
  getFormulaHeightKey,
  isHeightMeasurementScrollPaused,
  isHeightMeasurementSuspended,
  measureFormulaHeights,
} from './height-measurer';
import {
  registerIoPlaceholder,
  setForceHydrateAllInlineMathGroups,
  syncPlaceholderIo,
  unregisterIoPlaceholder,
  type ExternalIoCandidate,
} from './activation-controller';

import { endFunctionTimer, startFunctionTimer } from './function-timers';
const TEXTBLOCK_SELECTOR = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'td',
  'th',
].join(',');

export interface InlineMathRegistration {
  id: string;
  element: HTMLElement;
  preview: HTMLElement;
  contentDOM: HTMLElement;
  getPos: () => number | null;
  getParagraphPosition: () => number | null;
  getLatex: () => string;
  display: 'yes' | 'no';
  heightKey: () => string;
  activate: () => void;
  deactivate: () => void;
  update: () => void;
  active: boolean;
  requested: boolean;
  editing: boolean;
  prepared: boolean;
  groupId: string | null;
  destroyed: boolean;
  placeholderHeightKey: string | null;
  placeholderStyleKey?: string | null;
  formulaKey: string | null;
}

export interface InlineMathScrollAnchorProvider {
  capture(): { pmPos: number; offsetTop: number; scrollTop?: number; scrollHeight?: number; clientHeight?: number; atBottom?: boolean } | null;
  restore(anchor: { pmPos: number; offsetTop: number; scrollTop?: number; scrollHeight?: number; clientHeight?: number; atBottom?: boolean }): void;
}

export interface InlineMathViewportScanStats {
  scanned: number;
  visible: number;
  prepared: number;
  activated: number;
}

interface InlineMathGroup {
  id: string;
  key: string;
  element: HTMLElement;
  paragraph: HTMLElement | null;
  formulas: Set<InlineMathRegistration>;
  firstPmPos: number;
  lastPmPos: number;
  active: boolean;
  requested: boolean;
  heightKnown: boolean;
  observedElement: HTMLElement | null;
}

const groups = new Map<string, InlineMathGroup>();
const groupByParagraph = new WeakMap<HTMLElement, InlineMathGroup>();
const paragraphGroupIds = new WeakMap<HTMLElement, number>();
const placeholderRegistrationsByHeightKey = new Map<string, Set<InlineMathRegistration>>();
const inlineMathRegistrationsByFormulaKey = new Map<string, Set<InlineMathRegistration>>();
const preparedFormulaHtml = new Map<string, string>();
const preparedFormulaFragments = new Map<string, DocumentFragment>();
const PREPARED_FORMULA_FRAGMENT_LIMIT = 2400;
const pendingHeightMeasurements = new Set<string>();
const layoutRetryFrames = new WeakMap<HTMLElement, number>();

let groupSeq = 0;
let paragraphGroupSeq = 0;
let sortedGroups: InlineMathGroup[] = [];
let sortDirty = true;
let inlineGroupPositionTree: InlineGroupPositionEntry | null = null;
const inlineGroupPositionIndex = new Map<string, InlineGroupPositionEntry>();
const inlineGroupPositionDirty = new Set<string>();
let inlineGroupPositionCount = 0;
let prefetchRequester: ((entries: FormulaIndexEntry[]) => void) | null = null;
let activatingGroupId: string | null = null;
let pendingGroups = new Set<InlineMathGroup>();
let inlineMathScrollAnchorProvider: InlineMathScrollAnchorProvider | null = null;
let inlineMathActivationFrameStart: number | null = null;
let inlineMathActivationMaxFrameMs = 0;
let inlineMathActivationReadyMs = 0;
let lastHydrateCenter: number | null = null;
let lastHydrateRadius: number | null = null;
let lastHydratePendingCount: number | null = null;
let lastHydrateActivated: number | null = null;

interface InlineMathGroupIndexTestCounters {
  sorts: number;
  rangeQueries: number;
  fullGroupScans: number;
}

const inlineMathGroupIndexTestCounters: InlineMathGroupIndexTestCounters = {
  sorts: 0,
  rangeQueries: 0,
  fullGroupScans: 0,
};

interface InlineGroupPositionEntry {
  key: string;
  group: InlineMathGroup;
  firstPmPos: number;
  lastPmPos: number;
  minFirstPmPos: number;
  maxLastPmPos: number;
  priority: number;
  left: InlineGroupPositionEntry | null;
  right: InlineGroupPositionEntry | null;
  size: number;
}

function getInlineGroupPositionPriority(key: string): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

function compareInlineGroupPositionEntries(
  left: Pick<InlineGroupPositionEntry, 'key' | 'firstPmPos'>,
  right: Pick<InlineGroupPositionEntry, 'key' | 'firstPmPos'>,
): number {
  if (left.firstPmPos !== right.firstPmPos) {
    return left.firstPmPos - right.firstPmPos;
  }
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

function updateInlineGroupPositionEntrySize(entry: InlineGroupPositionEntry): void {
  const left = entry.left;
  const right = entry.right;
  entry.size = 1 + (left?.size ?? 0) + (right?.size ?? 0);
  entry.minFirstPmPos = Math.min(
    entry.firstPmPos,
    left?.minFirstPmPos ?? Number.POSITIVE_INFINITY,
    right?.minFirstPmPos ?? Number.POSITIVE_INFINITY,
  );
  entry.maxLastPmPos = Math.max(
    entry.lastPmPos,
    left?.maxLastPmPos ?? Number.NEGATIVE_INFINITY,
    right?.maxLastPmPos ?? Number.NEGATIVE_INFINITY,
  );
}

function rotateInlineGroupPositionRight(
  root: InlineGroupPositionEntry,
): InlineGroupPositionEntry {
  const pivot = root.left!;
  root.left = pivot.right;
  pivot.right = root;
  updateInlineGroupPositionEntrySize(root);
  updateInlineGroupPositionEntrySize(pivot);
  return pivot;
}

function rotateInlineGroupPositionLeft(
  root: InlineGroupPositionEntry,
): InlineGroupPositionEntry {
  const pivot = root.right!;
  root.right = pivot.left;
  pivot.left = root;
  updateInlineGroupPositionEntrySize(root);
  updateInlineGroupPositionEntrySize(pivot);
  return pivot;
}

function insertInlineGroupPositionEntry(
  root: InlineGroupPositionEntry | null,
  entry: InlineGroupPositionEntry,
): InlineGroupPositionEntry {
  if (root === null) {
    entry.left = null;
    entry.right = null;
    entry.size = 1;
    entry.minFirstPmPos = entry.firstPmPos;
    entry.maxLastPmPos = entry.lastPmPos;
    return entry;
  }

  if (compareInlineGroupPositionEntries(entry, root) < 0) {
    root.left = insertInlineGroupPositionEntry(root.left, entry);
    if (root.left!.priority > root.priority) {
      root = rotateInlineGroupPositionRight(root);
    }
  } else {
    root.right = insertInlineGroupPositionEntry(root.right, entry);
    if (root.right!.priority > root.priority) {
      root = rotateInlineGroupPositionLeft(root);
    }
  }

  updateInlineGroupPositionEntrySize(root);
  return root;
}

function removeInlineGroupPositionEntry(
  root: InlineGroupPositionEntry | null,
  firstPmPos: number,
  key: string,
): InlineGroupPositionEntry | null {
  if (root === null) {
    return null;
  }

  const comparison =
    firstPmPos !== root.firstPmPos
      ? firstPmPos - root.firstPmPos
      : key < root.key
        ? -1
        : key > root.key
          ? 1
          : 0;
  if (comparison < 0) {
    root.left = removeInlineGroupPositionEntry(root.left, firstPmPos, key);
  } else if (comparison > 0) {
    root.right = removeInlineGroupPositionEntry(root.right, firstPmPos, key);
  } else {
    return mergeInlineGroupPositionEntries(root.left, root.right);
  }

  updateInlineGroupPositionEntrySize(root);
  return root;
}

function mergeInlineGroupPositionEntries(
  left: InlineGroupPositionEntry | null,
  right: InlineGroupPositionEntry | null,
): InlineGroupPositionEntry | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  if (left.priority > right.priority) {
    left.right = mergeInlineGroupPositionEntries(left.right, right);
    updateInlineGroupPositionEntrySize(left);
    return left;
  }
  right.left = mergeInlineGroupPositionEntries(left, right.left);
  updateInlineGroupPositionEntrySize(right);
  return right;
}

function removeInlineGroupPosition(group: InlineMathGroup): void {
  const entry = inlineGroupPositionIndex.get(group.key);
  if (!entry) {
    return;
  }
  inlineGroupPositionIndex.delete(group.key);
  inlineGroupPositionDirty.delete(group.key);
  inlineGroupPositionTree = removeInlineGroupPositionEntry(
    inlineGroupPositionTree,
    entry.firstPmPos,
    group.key,
  );
  inlineGroupPositionCount -= 1;
}

function flushInlineGroupPositionDirty(): void {
  if (inlineGroupPositionDirty.size === 0) {
    return;
  }
  for (const key of Array.from(inlineGroupPositionDirty)) {
    const existing = inlineGroupPositionIndex.get(key);
    if (existing) {
      inlineGroupPositionIndex.delete(key);
      inlineGroupPositionTree = removeInlineGroupPositionEntry(
        inlineGroupPositionTree,
        existing.firstPmPos,
        key,
      );
      inlineGroupPositionCount -= 1;
    }
    const group = groups.get(key);
    if (group && Number.isFinite(group.firstPmPos)) {
      const entry: InlineGroupPositionEntry = {
        key,
        group,
        firstPmPos: group.firstPmPos,
        lastPmPos: group.lastPmPos,
        minFirstPmPos: group.firstPmPos,
        maxLastPmPos: group.lastPmPos,
        priority: getInlineGroupPositionPriority(key),
        left: null,
        right: null,
        size: 1,
      };
      inlineGroupPositionIndex.set(key, entry);
      inlineGroupPositionTree = insertInlineGroupPositionEntry(
        inlineGroupPositionTree,
        entry,
      );
      inlineGroupPositionCount += 1;
    }
    inlineGroupPositionDirty.delete(key);
  }
}

function markGroupPositionDirty(group: InlineMathGroup): void {
  inlineGroupPositionDirty.add(group.key);
}

function publishInlineMathActivationMetrics(): void {
  if (typeof window === 'undefined') {
    return;
  }
  const benchmarkWindow = window as unknown as Record<string, unknown>;
  benchmarkWindow.__marivellInlineMathActivationMaxFrameMs =
    inlineMathActivationMaxFrameMs;
  benchmarkWindow.__marivellInlineMathActivationReadyMs =
    inlineMathActivationReadyMs;
  benchmarkWindow.__marivellResetInlineMathActivationMetrics =
    resetInlineMathActivationMaxFrameMsForTest;
}

function withInlineMathActivationMeasurement<T>(operation: () => T): T {
  const startedHere = inlineMathActivationFrameStart === null;
  if (startedHere) {
    inlineMathActivationFrameStart = performance.now();
  }
  try {
    return operation();
  } finally {
    if (startedHere) {
      const startedAt = inlineMathActivationFrameStart;
      inlineMathActivationMaxFrameMs = Math.max(
        inlineMathActivationMaxFrameMs,
        performance.now() - (startedAt ?? performance.now()),
      );
      inlineMathActivationFrameStart = null;
      publishInlineMathActivationMetrics();
    }
  }
}

export function resetInlineMathActivationMaxFrameMsForTest(): void {
  inlineMathActivationMaxFrameMs = 0;
  inlineMathActivationReadyMs = 0;
  inlineMathActivationFrameStart = null;
  publishInlineMathActivationMetrics();
}

export function getInlineMathActivationMaxFrameMsForTest(): number {
  return inlineMathActivationMaxFrameMs;
}

export function setInlineMathScrollAnchorProvider(
  provider: InlineMathScrollAnchorProvider | null,
): void {
  inlineMathScrollAnchorProvider = provider;
}

function addPlaceholderRegistration(registration: InlineMathRegistration): void {
  if (registration.active || registration.destroyed) {
    registration.placeholderHeightKey = null;
    registration.placeholderStyleKey = null;
    return;
  }
  registration.placeholderStyleKey = null;
  const key = registration.heightKey();
  let registrations = placeholderRegistrationsByHeightKey.get(key);
  if (!registrations) {
    registrations = new Set();
    placeholderRegistrationsByHeightKey.set(key, registrations);
  }
  registrations.add(registration);
  registration.placeholderHeightKey = key;
}

function syncRegistrationFormulaKey(registration: InlineMathRegistration): void {
  if (registration.formulaKey) {
    const previous = inlineMathRegistrationsByFormulaKey.get(registration.formulaKey);
    previous?.delete(registration);
    if (previous?.size === 0) {
      inlineMathRegistrationsByFormulaKey.delete(registration.formulaKey);
    }
  }
  registration.formulaKey = getFormulaCacheKey(
    registration.getLatex(),
    registration.display,
  );
  let registrations = inlineMathRegistrationsByFormulaKey.get(registration.formulaKey);
  if (!registrations) {
    registrations = new Set();
    inlineMathRegistrationsByFormulaKey.set(registration.formulaKey, registrations);
  }
  registrations.add(registration);
}

function removeRegistrationFormulaKey(registration: InlineMathRegistration): void {
  if (!registration.formulaKey) {
    return;
  }
  const registrations = inlineMathRegistrationsByFormulaKey.get(registration.formulaKey);
  registrations?.delete(registration);
  if (registrations?.size === 0) {
    inlineMathRegistrationsByFormulaKey.delete(registration.formulaKey);
  }
  registration.formulaKey = null;
}

function removePlaceholderRegistration(registration: InlineMathRegistration): void {
  const key = registration.placeholderHeightKey;
  registration.placeholderHeightKey = null;
  registration.placeholderStyleKey = null;
  if (!key) {
    return;
  }
  const registrations = placeholderRegistrationsByHeightKey.get(key);
  if (!registrations) {
    return;
  }
  registrations.delete(registration);
  if (registrations.size === 0) {
    placeholderRegistrationsByHeightKey.delete(key);
  }
}

export function syncInlineMathPlaceholderKey(registration: InlineMathRegistration): void {
  if (registration.active || registration.destroyed) {
    removePlaceholderRegistration(registration);
    return;
  }
  const key = registration.heightKey();
  if (registration.placeholderHeightKey === key) {
    return;
  }
  removePlaceholderRegistration(registration);
  addPlaceholderRegistration(registration);
}

function applyPlaceholderHeightStyles(registration: InlineMathRegistration, key: string): void {
  if (registration.active || registration.destroyed) {
    registration.placeholderStyleKey = null;
    return;
  }
  const height = getCachedNodeHeight(key);
  if (height === null) {
    return;
  }
  const width = getCachedNodeWidth(key);
  const styleKey = `${height}|${width ?? ''}`;
  if (registration.placeholderStyleKey === styleKey) {
    return;
  }
  registration.placeholderStyleKey = styleKey;
  registration.preview.style.display = 'inline-block';
  registration.preview.style.boxSizing = 'border-box';
  registration.preview.style.overflow = 'hidden';
  registration.preview.style.height = `${height}px`;
  registration.preview.style.minHeight = `${height}px`;
  registration.preview.style.lineHeight = `${height}px`;
  registration.preview.style.whiteSpace = 'nowrap';
  registration.preview.style.verticalAlign = 'middle';
  if (width !== null) {
    registration.preview.style.minWidth = `${width}px`;
    registration.preview.style.maxWidth = `${width}px`;
    registration.element.style.minWidth = `${width}px`;
    registration.element.style.maxWidth = `${width}px`;
  }
  registration.element.style.overflow = 'hidden';
  registration.element.style.height = `${height}px`;
  registration.element.style.minHeight = `${height}px`;
  registration.element.style.lineHeight = `${height}px`;
  registration.element.style.verticalAlign = 'middle';
}

function refreshPlaceholderHeights(seededKeys: string[] | null): void {
  if (isHeightMeasurementSuspended()) {
    return;
  }
  if (seededKeys !== null && seededKeys.length > 0) {
    for (const key of seededKeys) {
      const registrations = placeholderRegistrationsByHeightKey.get(key);
      if (!registrations) {
        continue;
      }
      for (const registration of registrations) {
        applyPlaceholderHeightStyles(registration, key);
      }
    }
    return;
  }

  for (const [key, registrations] of placeholderRegistrationsByHeightKey) {
    for (const registration of registrations) {
      applyPlaceholderHeightStyles(registration, key);
    }
  }
}

let unsubscribeHeightCacheSeeded = subscribeNodeHeightCacheSeeded(refreshPlaceholderHeights);
let unsubscribeHeightCacheInvalidation = subscribeNodeHeightCacheInvalidation(() => {
  placeholderRegistrationsByHeightKey.clear();
  for (const group of groups.values()) {
    for (const registration of group.formulas) {
      addPlaceholderRegistration(registration);
    }
  }
});

function getParagraphElement(element: HTMLElement): HTMLElement | null {
  if (!element.isConnected) {
    return null;
  }
  return element.closest<HTMLElement>(TEXTBLOCK_SELECTOR) ?? element.parentElement;
}

function getRegistrationParagraphElement(registration: InlineMathRegistration): HTMLElement | null {
  return getParagraphElement(registration.element);
}

function getKeyForParagraph(paragraph: HTMLElement): string {
  let paragraphId = paragraphGroupIds.get(paragraph);
  if (paragraphId === undefined) {
    paragraphId = ++paragraphGroupSeq;
    paragraphGroupIds.set(paragraph, paragraphId);
  }
  return `el:${paragraphId}`;
}

function markSortDirty(group?: InlineMathGroup): void {
  sortDirty = true;
  if (group) {
    markGroupPositionDirty(group);
  }
}

function unregisterGroup(group: InlineMathGroup): void {
  if (group.observedElement !== null) {
    unregisterIoPlaceholder(group.id);
  }
  group.observedElement = null;
  if (group.paragraph !== null) {
    const current = groupByParagraph.get(group.paragraph);
    if (current === group) {
      groupByParagraph.delete(group.paragraph);
    }
  }
  pendingGroups.delete(group);
  groups.delete(group.key);
  removeInlineGroupPosition(group);
}

function refreshGroupBounds(group: InlineMathGroup): void {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const registration of group.formulas) {
    const position = registration.getPos();
    if (position === null) {
      continue;
    }
    first = Math.min(first, position);
    last = Math.max(last, position);
  }
  group.firstPmPos = Number.isFinite(first) ? first : 0;
  group.lastPmPos = Number.isFinite(last) ? last : 0;
  markGroupPositionDirty(group);
}

function updateGroupPosition(group: InlineMathGroup, registration: InlineMathRegistration): void {
  const position = registration.getPos();
  if (position === null) {
    return;
  }
  group.firstPmPos = Math.min(group.firstPmPos, position);
  group.lastPmPos = Math.max(group.lastPmPos, position);
  markGroupPositionDirty(group);
}

function getGroupElement(group: InlineMathGroup): HTMLElement {
  return group.paragraph ?? group.element;
}

function activateGroupWithAnchor(group: InlineMathGroup): void {
  const anchor = inlineMathScrollAnchorProvider?.capture() ?? null;
  try {
    withInlineMathActivationMeasurement(() => {
      activateGroup(group);
    });
  } finally {
    if (anchor !== null) {
      inlineMathScrollAnchorProvider?.restore(anchor);
    }
  }
}

function observeGroup(group: InlineMathGroup): void {
  const element = getGroupElement(group);
  if (group.observedElement === element) {
    return;
  }
  if (group.observedElement !== null) {
    unregisterIoPlaceholder(group.id);
  }
  group.observedElement = element;
  registerIoPlaceholder(element, group.id, {
    getPosition: () => Number.isFinite(group.firstPmPos) ? group.firstPmPos : 0,
    isActive: () => group.active,
    activate: () => activateGroupWithAnchor(group),
  });
}

function refreshGroupParagraph(group: InlineMathGroup): void {
  const nextParagraph =
    Array.from(group.formulas).map(getRegistrationParagraphElement).find(Boolean) ?? null;
  if (nextParagraph === group.paragraph) {
    return;
  }
  if (group.paragraph !== null) {
    const current = groupByParagraph.get(group.paragraph);
    if (current === group) {
      groupByParagraph.delete(group.paragraph);
    }
    pendingGroups.delete(group);
  }
  group.paragraph = nextParagraph;
  if (nextParagraph !== null) {
    group.element = nextParagraph;
    groupByParagraph.set(nextParagraph, group);
  } else {
    pendingGroups.add(group);
  }
  observeGroup(group);
  markSortDirty(group);
}

function createGroup(key: string, registration: InlineMathRegistration): InlineMathGroup {
  const paragraph = getRegistrationParagraphElement(registration);
  const group: InlineMathGroup = {
    id: `inline-math-group-${++groupSeq}`,
    key,
    element: registration.element,
    paragraph,
    formulas: new Set(),
    firstPmPos: Number.POSITIVE_INFINITY,
    lastPmPos: Number.NEGATIVE_INFINITY,
    active: registration.active,
    requested: registration.requested,
    heightKnown: false,
    observedElement: null,
  };
  if (paragraph !== null) {
    group.element = paragraph;
    groupByParagraph.set(paragraph, group);
  } else {
    pendingGroups.add(group);
  }
  observeGroup(group);
  groups.set(key, group);
  return group;
}

function removeRegistrationFromGroup(registration: InlineMathRegistration): void {
  if (!registration.groupId) {
    return;
  }
  const group = groups.get(registration.groupId);
  registration.groupId = null;
  removePlaceholderRegistration(registration);
  removeRegistrationFormulaKey(registration);
  if (!group) {
    return;
  }

  group.formulas.delete(registration);
  if (group.formulas.size === 0) {
    unregisterGroup(group);
    return;
  }

  const removedPos = registration.getPos();
  if (
    removedPos !== null &&
    (removedPos === group.firstPmPos || removedPos === group.lastPmPos)
  ) {
    refreshGroupBounds(group);
  }
  refreshGroupParagraph(group);
  markSortDirty(group);
}

function assignRegistrationToGroup(registration: InlineMathRegistration): InlineMathGroup | null {
  const paragraph = getRegistrationParagraphElement(registration);
  const key = paragraph ? getKeyForParagraph(paragraph) : `node:${registration.id}`;
  const previousKey = registration.groupId;
  if (previousKey === key) {
    const existing = groups.get(key);
    if (existing) {
      existing.formulas.add(registration);
      updateGroupPosition(existing, registration);
      return existing;
    }
  } else if (previousKey) {
    removeRegistrationFromGroup(registration);
  }

  let group = groups.get(key);
  if (!group) {
    group = createGroup(key, registration);
  } else if (group.paragraph === null && paragraph !== null) {
    group.paragraph = paragraph;
    group.element = paragraph;
    groupByParagraph.set(paragraph, group);
    pendingGroups.delete(group);
    observeGroup(group);
  }

  registration.groupId = group.key;
  group.formulas.add(registration);
  syncRegistrationFormulaKey(registration);
  updateGroupPosition(group, registration);
  if (group.paragraph === null) {
    refreshGroupParagraph(group);
  }
  markSortDirty(group);
  return group;
}

function reconcilePendingGroups(): void {
  if (pendingGroups.size === 0) {
    return;
  }
  for (const group of Array.from(pendingGroups)) {
    if (group.paragraph !== null || group.formulas.size === 0) {
      pendingGroups.delete(group);
      continue;
    }
    const first = Array.from(group.formulas)[0];
    const paragraph = first ? getRegistrationParagraphElement(first) : null;
    if (!paragraph) {
      continue;
    }
    const key = getKeyForParagraph(paragraph);
    if (key === group.key) {
      group.paragraph = paragraph;
      group.element = paragraph;
      groupByParagraph.set(paragraph, group);
      pendingGroups.delete(group);
      observeGroup(group);
      continue;
    }
    const moved = Array.from(group.formulas);
    for (const registration of moved) {
      registration.groupId = null;
      group.formulas.delete(registration);
      assignRegistrationToGroup(registration);
    }
    if (group.formulas.size === 0) {
      unregisterGroup(group);
    }
  }
}

function getSortedGroups(): InlineMathGroup[] {
  reconcilePendingGroups();
  flushInlineGroupPositionDirty();
  const result: InlineMathGroup[] = [];
  collectInlineGroupPositionInOrder(inlineGroupPositionTree, result);
  return result;
}

function collectInlineGroupPositionInOrder(
  root: InlineGroupPositionEntry | null,
  result: InlineMathGroup[],
): void {
  if (root === null) {
    return;
  }
  collectInlineGroupPositionInOrder(root.left, result);
  result.push(root.group);
  collectInlineGroupPositionInOrder(root.right, result);
}

function collectInlineGroupPositionRange(
  root: InlineGroupPositionEntry | null,
  low: number,
  high: number,
  result: InlineMathGroup[],
): void {
  if (root === null) {
    return;
  }
  if (
    root.left &&
    root.left.minFirstPmPos <= high &&
    root.left.maxLastPmPos >= low
  ) {
    collectInlineGroupPositionRange(root.left, low, high, result);
  }
  if (
    root.firstPmPos <= high &&
    root.lastPmPos >= low
  ) {
    result.push(root.group);
  }
  if (
    root.firstPmPos <= high &&
    root.right &&
    root.right.maxLastPmPos >= low
  ) {
    collectInlineGroupPositionRange(root.right, low, high, result);
  }
}

function hasFormulaHtmlReady(entry: FormulaIndexEntry): boolean {
  const cacheKey = entry.key || getFormulaCacheKey(entry.latex, entry.display);
  if (getPreparedInlineFormulaHtml(cacheKey) !== null) {
    return true;
  }
  return getCachedFormulaHtml(entry.latex, entry.display) !== null;
}

function hasAllFormulaHtmlPrepared(): boolean {
  return (
    preparedFormulaHtml.size > 0 &&
    preparedFormulaHtml.size >= inlineMathRegistrationsByFormulaKey.size
  );
}

function requestPrefetch(entries: FormulaIndexEntry[]): void {
  if (!entries.length || !prefetchRequester) {
    return;
  }

  const missing = new Map<string, FormulaIndexEntry>();
  for (const entry of entries) {
    if (hasFormulaHtmlReady(entry)) {
      continue;
    }
    const cacheKey = getFormulaCacheKey(entry.latex, entry.display);
    if (!missing.has(cacheKey)) {
      missing.set(cacheKey, entry);
    }
  }
  const missingEntries = Array.from(missing.values()).filter(
    (entry) => !hasFormulaHtmlReady(entry),
  );
  if (missingEntries.length > 0) {
    prefetchRequester(missingEntries);
  }
}

function collectGroupFormulaEntries(group: InlineMathGroup): FormulaIndexEntry[] {
  const entries: FormulaIndexEntry[] = [];
  for (const registration of group.formulas) {
    const key = getFormulaCacheKey(registration.getLatex(), registration.display);
    const entry = {
      key,
      latex: registration.getLatex(),
      display: registration.display,
    };
    if (!hasFormulaHtmlReady(entry)) {
      entries.push(entry);
    }
  }
  return entries;
}

function hasResidualPlaceholders(group: InlineMathGroup): boolean {
  for (const registration of group.formulas) {
    if (!registration.destroyed && !registration.active) {
      return true;
    }
  }
  return false;
}

function prepareGroup(group: InlineMathGroup): void {
  if (group.active) {
    return;
  }
  group.requested = true;
  for (const registration of group.formulas) {
    registration.requested = true;
  }
  if (!hasAllFormulaHtmlPrepared()) {
    const entries = collectGroupFormulaEntries(group);
    requestPrefetch(entries.slice(0, Math.min(48, entries.length)));
  }
}

function activateGroup(group: InlineMathGroup): void {
  startFunctionTimer('activateGroup');
  if (activatingGroupId === group.id) {
    return;
  }
  activatingGroupId = group.id;
  try {
    group.active = true;
    group.requested = true;
    for (const registration of group.formulas) {
      if (!registration.active) {
        registration.active = true;
        removePlaceholderRegistration(registration);
        registration.activate();
      }
      registration.requested = true;
    }
    if (!hasAllFormulaHtmlPrepared()) {
      requestPrefetch(collectGroupFormulaEntries(group).slice(0, 48));
    }
  } finally {
    activatingGroupId = null;
  }
  endFunctionTimer('activateGroup');
}

export function deactivateAllInlineMathGroups(): number {
  let deactivatedCount = 0;
  for (const group of Array.from(groups.values())) {
    let hadActive = false;
    for (const registration of group.formulas) {
      if (!registration.destroyed && registration.active) {
        hadActive = true;
        registration.active = false;
        registration.deactivate();
      } else if (!registration.destroyed && !registration.active) {
        registration.preview.remove();
      }
    }
    group.active = false;
    group.requested = false;
    if (hadActive) {
      deactivatedCount += 1;
    }
  }
  return deactivatedCount;
}

type GroupViewportRelation = 'visible' | 'prefetch' | 'none';

function getGroupViewportRelation(
  group: InlineMathGroup,
  frame: HTMLElement,
  margin: number,
): GroupViewportRelation {
  const element = getGroupElement(group);
  if (!element.isConnected) {
    return 'none';
  }
  const frameRect = frame.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  if (rect.bottom > frameRect.top && rect.top < frameRect.bottom) {
    return 'visible';
  }
  if (rect.bottom > frameRect.top - margin && rect.top < frameRect.bottom + margin) {
    return 'prefetch';
  }
  return 'none';
}

export function registerInlineMathNode(registration: InlineMathRegistration): () => void {
  const group = assignRegistrationToGroup(registration);
  syncInlineMathPlaceholderKey(registration);
  markSortDirty(group ?? undefined);

  let removed = false;
  return () => {
    if (removed) {
      return;
    }
    removed = true;
    registration.destroyed = true;
    removeRegistrationFromGroup(registration);
  };
}

export function updateInlineMathRegistration(registration: InlineMathRegistration): void {
  if (registration.destroyed) {
    return;
  }
  assignRegistrationToGroup(registration);
  syncRegistrationFormulaKey(registration);
  syncInlineMathPlaceholderKey(registration);

  if (registration.active) {
    registration.requested = true;
    if (!hasAllFormulaHtmlPrepared()) {
      requestPrefetch([
        {
          key: getFormulaCacheKey(registration.getLatex(), registration.display),
          latex: registration.getLatex(),
          display: registration.display,
        },
      ]);
    }
  }
}

export function activateInlineMathNode(registration: InlineMathRegistration): void {
  const anchor = inlineMathScrollAnchorProvider?.capture() ?? null;
  try {
    withInlineMathActivationMeasurement(() => {
      const group = registration.groupId ? groups.get(registration.groupId) : undefined;
      if (group) {
        activateGroup(group);
        return;
      }

      registration.active = true;
      removePlaceholderRegistration(registration);
      registration.requested = true;
      registration.activate();
      if (!hasAllFormulaHtmlPrepared()) {
        requestPrefetch([
          {
            key: getFormulaCacheKey(registration.getLatex(), registration.display),
            latex: registration.getLatex(),
            display: registration.display,
          },
        ]);
      }
    });
  } finally {
    if (anchor !== null) {
      inlineMathScrollAnchorProvider?.restore(anchor);
    }
  }
}

export function isInlineMathNodeInViewport(
  registration: InlineMathRegistration,
  margin = 1600,
): boolean {
  const frame = registration.element.closest<HTMLElement>('.editor-frame');
  if (!frame || typeof IntersectionObserver === 'undefined') {
    return true;
  }
  const element = registration.element;
  if (!element.isConnected) {
    return false;
  }
  const frameRect = frame.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return rect.bottom > frameRect.top - margin && rect.top < frameRect.bottom + margin;
}

export function activateInlineMathGroupsInViewport(
  frame: HTMLElement,
  margin = 1600,
  centerPosition?: number,
  positionRadius?: number,
  stats?: InlineMathViewportScanStats | null,
  allowLayoutRetry = true,
  skipAnchorRestore = false,
): number {
  startFunctionTimer('activateInlineMathGroupsInViewport');
  const sorted = getSortedGroups();
  if (!frame || typeof IntersectionObserver === 'undefined') {
    const anchor = inlineMathScrollAnchorProvider?.capture() ?? null;
    const activated = withInlineMathActivationMeasurement(() => {
      if (stats) {
        stats.scanned = sorted.length;
        stats.visible = sorted.length;
        stats.activated = sorted.length;
      }
      for (const group of sorted) {
        activateGroup(group);
      }
      return sorted.length;
    });
    if (anchor !== null) {
      inlineMathScrollAnchorProvider?.restore(anchor);
    }
    return activated;
  }

  const firstGroup = sorted[0];
  const firstElement = firstGroup ? getGroupElement(firstGroup) : null;
  if (
    allowLayoutRetry &&
    firstElement &&
    firstElement.isConnected &&
    firstElement.getBoundingClientRect().height <= 0
  ) {
    const retries = layoutRetryFrames.get(frame) ?? 0;
    if (retries < 3) {
      layoutRetryFrames.set(frame, retries + 1);
      requestAnimationFrame(() => {
        layoutRetryFrames.delete(frame);
        if (frame.isConnected) {
          activateInlineMathGroupsInViewport(frame, margin);
        }
      });
    }
    endFunctionTimer('activateInlineMathGroupsInViewport');
    return 0;
  }
  layoutRetryFrames.delete(frame);

  const usePositionIndex =
    centerPosition !== undefined &&
    Number.isFinite(centerPosition) &&
    positionRadius !== undefined &&
    Number.isFinite(positionRadius) &&
    positionRadius > 0;
  if (usePositionIndex) {
    const radius = positionRadius as number;
    const groupsToScan = getInlineMathGroupsInPositionRange(centerPosition, radius * 4);
    const toActivate: InlineMathGroup[] = [];
    for (const group of groupsToScan) {
      const distance = getGroupDistance(group, centerPosition as number);
      if (group.active && !hasResidualPlaceholders(group)) {
        group.requested = true;
        if (!hasAllFormulaHtmlPrepared()) {
          requestPrefetch(collectGroupFormulaEntries(group).slice(0, 48));
        }
      } else if (distance <= radius) {
        toActivate.push(group);
      } else if (distance <= radius * 2) {
        prepareGroup(group);
      }
    }
    let activated = 0;
    if (toActivate.length > 0) {
      const anchor = inlineMathScrollAnchorProvider?.capture() ?? null;
      activated = withInlineMathActivationMeasurement(() => {
        for (const group of toActivate) {
          activateGroup(group);
        }
        return toActivate.length;
      });
      if (anchor !== null) {
        inlineMathScrollAnchorProvider?.restore(anchor);
      }
    }
    syncInlineMathIo(frame, centerPosition, radius * 1.5);
    endFunctionTimer('activateInlineMathGroupsInViewport');
    return activated;
  }

  inlineMathGroupIndexTestCounters.fullGroupScans += 1;
  const frameRect = frame.getBoundingClientRect();
  const prefetchTop = frameRect.top - margin;
  const prefetchBottom = frameRect.bottom + margin;
  const toActivate: InlineMathGroup[] = [];
  for (const group of sorted) {
    if (stats) {
      stats.scanned += 1;
    }
    const element = getGroupElement(group);
    if (!element.isConnected) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (rect.bottom < prefetchTop) {
      continue;
    }
    if (rect.top > prefetchBottom) {
      break;
    }
    const relation = getGroupViewportRelation(group, frame, margin);
    if (relation === 'none') {
      continue;
    }
    if (relation === 'prefetch') {
      if (stats) {
        stats.prepared += 1;
      }
      if (!group.active) {
        prepareGroup(group);
      }
      continue;
    }
    if (stats) {
      stats.visible += 1;
    }
    if (!group.active || hasResidualPlaceholders(group)) {
      toActivate.push(group);
    } else {
      group.requested = true;
      if (!hasAllFormulaHtmlPrepared()) {
        requestPrefetch(collectGroupFormulaEntries(group).slice(0, 48));
      }
    }
  }
  if (toActivate.length > 0) {
    const anchor = skipAnchorRestore
      ? null
      : inlineMathScrollAnchorProvider?.capture() ?? null;
    const activated = withInlineMathActivationMeasurement(() => {
      for (const group of toActivate) {
        activateGroup(group);
      }
      return toActivate.length;
    });
    if (anchor !== null) {
      inlineMathScrollAnchorProvider?.restore(anchor);
    }
    if (stats) {
      stats.activated = toActivate.length;
    }
    return activated;
  }
  return 0;
}

export function forceHydrateAllInlineMathGroups(): number {
  startFunctionTimer('activateInlineMathGroupsInViewport');
  const sorted = getSortedGroups();
  const anchor = inlineMathScrollAnchorProvider?.capture() ?? null;
  let activated = 0;
  try {
    withInlineMathActivationMeasurement(() => {
      for (const group of sorted) {
        if (group.active && !hasResidualPlaceholders(group)) {
          group.requested = true;
          if (!hasAllFormulaHtmlPrepared()) {
            requestPrefetch(collectGroupFormulaEntries(group).slice(0, 48));
          }
          continue;
        }
        activateGroup(group);
        activated += 1;
      }
    });
  } finally {
    if (anchor !== null) {
      inlineMathScrollAnchorProvider?.restore(anchor);
    }
  }
  return activated;
}

setForceHydrateAllInlineMathGroups(forceHydrateAllInlineMathGroups);

function getGroupDistance(group: InlineMathGroup, centerPosition: number): number {
  if (centerPosition < group.firstPmPos) {
    return group.firstPmPos - centerPosition;
  }
  if (centerPosition > group.lastPmPos) {
    return centerPosition - group.lastPmPos;
  }
  return 0;
}

function getInlineMathGroupsInPositionRange(
  centerPosition: number,
  maxDistance: number,
): InlineMathGroup[] {
  inlineMathGroupIndexTestCounters.rangeQueries += 1;
  reconcilePendingGroups();
  flushInlineGroupPositionDirty();
  const low = centerPosition - maxDistance;
  const high = centerPosition + maxDistance;
  const matches: InlineMathGroup[] = [];
  collectInlineGroupPositionRange(inlineGroupPositionTree, low, high, matches);
  return matches;
}

export function syncInlineMathIo(
  frame: HTMLElement,
  centerPosition: number,
  viewportRadius: number,
): number {
  const radius = Math.max(
    Number.isFinite(viewportRadius) ? viewportRadius : 1,
    1,
  );
  // The caller's radius is 1.5x viewport in scroll paths; 2x is +/-3 viewports.
  const candidateRadius = radius * 2;
  const groupsInRange = getInlineMathGroupsInPositionRange(
    centerPosition,
    candidateRadius,
  );
  const candidates: ExternalIoCandidate[] = [];
  for (const group of groupsInRange) {
    if (group.active || !group.element.isConnected) {
      continue;
    }
    candidates.push({
      id: group.id,
      element: getGroupElement(group),
      position: Number.isFinite(group.firstPmPos) ? group.firstPmPos : 0,
    });
  }
  return syncPlaceholderIo(frame, centerPosition, candidateRadius, candidates);
}

export function countInlineMathPlaceholdersInPositionRange(
  centerPosition: number,
  radius: number,
): number {
  const groupsInRange = getInlineMathGroupsInPositionRange(centerPosition, radius);
  let count = 0;
  for (const group of groupsInRange) {
    for (const registration of group.formulas) {
      if (!registration.destroyed && !registration.active) {
        count += 1;
      }
    }
  }
  return count;
}

export function hydrateInlineMathGroupsAroundPosition(
  frame: HTMLElement,
  centerPosition: number,
  viewportRadius: number,
  _margin = 1600,
): number {
  startFunctionTimer('hydrateInlineMathGroupsAroundPosition');

  // Skip redundant scans: if the same center+radius already yielded zero
  // activations and no new pending groups arrived, the result won't change.
  const currentPendingCount = pendingGroups.size;
  if (
    lastHydrateCenter === centerPosition &&
    lastHydrateRadius === viewportRadius &&
    lastHydratePendingCount === currentPendingCount &&
    lastHydrateActivated === 0
  ) {
    endFunctionTimer('hydrateInlineMathGroupsAroundPosition');
    return 0;
  }

  const radius = Math.max(Number.isFinite(viewportRadius) ? viewportRadius : 1, 1);
  const activationRadius = radius * 1.5;
  const groupsInRange = getInlineMathGroupsInPositionRange(centerPosition, radius * 6);
  const toActivate: InlineMathGroup[] = [];
  for (const group of groupsInRange) {
    if (!group || group.active) {
      continue;
    }
    const distance = getGroupDistance(group, centerPosition);
    if (distance <= activationRadius) {
      toActivate.push(group);
    }
  }

  let activated = 0;
  if (toActivate.length === 0) {
    syncInlineMathIo(frame, centerPosition, viewportRadius);
    return 0;
  }
  let activationFallbackMs = 0;
  const anchor = inlineMathScrollAnchorProvider?.capture() ?? null;
  activated = withInlineMathActivationMeasurement(() => {
    const activationStart = performance.now();
    try {
      for (const group of toActivate) {
        activateGroup(group);
      }
      return toActivate.length;
    } finally {
      activationFallbackMs = performance.now() - activationStart;
    }
  });
  if (anchor !== null) {
    inlineMathScrollAnchorProvider?.restore(anchor);
  }
  syncInlineMathIo(frame, centerPosition, viewportRadius);
  if (activated > 0) {
    inlineMathActivationReadyMs = Math.max(inlineMathActivationReadyMs, activationFallbackMs);
    publishInlineMathActivationMetrics();
  }
  lastHydrateCenter = centerPosition;
  lastHydrateRadius = viewportRadius;
  lastHydratePendingCount = currentPendingCount;
  lastHydrateActivated = activated;
  endFunctionTimer('hydrateInlineMathGroupsAroundPosition');
  return activated;
}

export function getPreparedInlineFormulaHtml(key: string): string | null {
  return preparedFormulaHtml.get(key) ?? null;
}

export function getPreparedInlineFormulaFragment(
  key: string,
  html?: string | null,
): DocumentFragment | null {
  const templateClone = cloneFormulaTemplateContent(
    key,
    html ?? preparedFormulaHtml.get(key) ?? null,
  );
  if (templateClone !== null) {
    return templateClone;
  }

  const cached = preparedFormulaFragments.get(key);
  if (cached) {
    preparedFormulaFragments.delete(key);
    preparedFormulaFragments.set(key, cached);
    return cached.cloneNode(true) as DocumentFragment;
  }
  const sourceHtml = html ?? preparedFormulaHtml.get(key);
  if (typeof sourceHtml !== 'string' || !sourceHtml || typeof document === 'undefined') {
    return null;
  }
  try {
    const template = document.createElement('template');
    template.innerHTML = sourceHtml;
    const fragment = document.createDocumentFragment();
    fragment.append(...Array.from(template.content.childNodes));
    preparedFormulaFragments.set(key, fragment);
    if (preparedFormulaFragments.size > PREPARED_FORMULA_FRAGMENT_LIMIT) {
      const oldestKey = preparedFormulaFragments.keys().next().value;
      if (typeof oldestKey === 'string') {
        preparedFormulaFragments.delete(oldestKey);
      }
    }
    return fragment.cloneNode(true) as DocumentFragment;
  } catch {
    return null;
  }
}

export function prepareInlineMathForFormulaHtml(htmlByKey: Record<string, string>): void {
  const sources = new Map<string, { latex: string; display: 'yes' | 'no' }>();
  const htmlBySourceKey = new Map<string, string>();
  let elementForMeasurement: HTMLElement | null = null;
  for (const [key, html] of Object.entries(htmlByKey)) {
    if (typeof html !== 'string' || !html) {
      continue;
    }
    preparedFormulaHtml.set(key, html);
    htmlBySourceKey.set(key, html);
    const registrations = inlineMathRegistrationsByFormulaKey.get(key);
    if (registrations) {
      for (const registration of registrations) {
        if (registration.destroyed) {
          continue;
        }
        registration.prepared = true;
        elementForMeasurement ??= registration.element;
        if (!sources.has(key)) {
          sources.set(key, {
            latex: registration.getLatex(),
            display: registration.display,
          });
        }
      }
    }
    if (!sources.has(key)) {
      const separator = key.indexOf('\u0000');
      const displayName = separator >= 0 ? key.slice(0, separator) : '';
      const latex = separator >= 0 ? key.slice(separator + 1) : '';
      if (latex) {
        sources.set(key, {
          latex,
          display: displayName === 'block' ? 'yes' : 'no',
        });
      }
    }
  }

  if (sources.size === 0) {
    return;
  }
  const items = buildFormulaHeightMeasurementItems(
    Array.from(sources, ([key, source]) => ({ key, ...source })),
    Object.fromEntries(htmlBySourceKey),
    elementForMeasurement,
  );
  if (items.length === 0) {
    return;
  }
  const itemsToMeasure = items.filter(
    (item) =>
      getCachedNodeHeight(item.key) === null &&
      !pendingHeightMeasurements.has(item.key),
  );
  if (itemsToMeasure.length === 0) {
    return;
  }
  for (const item of itemsToMeasure) {
    pendingHeightMeasurements.add(item.key);
  }
  void measureFormulaHeights(itemsToMeasure).then((heights) => {
    const heightKeys = Object.keys(heights);
    for (const key of heightKeys) {
      pendingHeightMeasurements.delete(key);
      setCachedNodeHeight(key, heights[key]!);
    }
    notifyNodeHeightCacheSeeded(heightKeys);
  });
}

export function scheduleInlineMathHeightMeasurement(
  latex: string,
  display: 'yes' | 'no',
  html: string,
  element?: HTMLElement | null,
  heightKey?: string | null,
): void {
  const resolvedHeightKey = heightKey ?? getFormulaHeightKey(latex, display, element);
  if (
    getCachedNodeHeight(resolvedHeightKey) !== null ||
    pendingHeightMeasurements.has(resolvedHeightKey) ||
    isHeightMeasurementScrollPaused()
  ) {
    return;
  }
  pendingHeightMeasurements.add(resolvedHeightKey);

  const sourceKey = getFormulaCacheKey(latex, display);
  const items = buildFormulaHeightMeasurementItems(
    [{ key: sourceKey, latex, display }],
    { [sourceKey]: html },
    element,
  );
  if (items.length === 0) {
    pendingHeightMeasurements.delete(resolvedHeightKey);
    return;
  }

  void measureFormulaHeights(items).then((heights) => {
    pendingHeightMeasurements.delete(resolvedHeightKey);
    const heightKeys = Object.keys(heights);
    for (const key of heightKeys) {
      setCachedNodeHeight(key, heights[key]!);
    }
    notifyNodeHeightCacheSeeded(heightKeys);
  });
}

interface SelectionSyncEditor {
  state: {
    selection: { from: number; to: number; empty: boolean };
    doc: {
      nodeAt: (pos: number) => { type: { name: string }; nodeSize: number } | null;
      resolve: (pos: number) => {
        parent: { type: { name: string } };
        nodeBefore: { type: { name: string } } | null;
        nodeAfter: { type: { name: string } } | null;
      };
    };
  };
  view: { domAtPos: (pos: number) => { node: Node; offset: number } };
}

export function isInlineMathSelectionNearby(editor: SelectionSyncEditor): boolean {
  const { from, to, empty } = editor.state.selection;
  return selectionIntersectsInlineMath(editor, from, to, empty);
}

function selectionIntersectsInlineMath(
  editor: SelectionSyncEditor,
  from: number,
  to: number,
  empty: boolean,
): boolean {
  if (!empty) {
    return true;
  }

  try {
    const $from = editor.state.doc.resolve(from);
    if ($from.parent.type.name === 'inlineMath') {
      return true;
    }
    if ($from.nodeBefore?.type.name === 'inlineMath' || $from.nodeAfter?.type.name === 'inlineMath') {
      return true;
    }
    return editor.state.doc.nodeAt(from)?.type.name === 'inlineMath';
  } catch {
    return false;
  }
}

function findParagraphElementForPos(editor: SelectionSyncEditor, pos: number): HTMLElement | null {
  let dom;
  try {
    dom = editor.view.domAtPos(pos);
  } catch {
    return null;
  }
  if (!dom) {
    return null;
  }
  const node = dom.node;
  const element = node instanceof Element ? node : (node.parentElement ?? null);
  if (!element) {
    return null;
  }
  return element.closest<HTMLElement>(TEXTBLOCK_SELECTOR);
}

export function syncInlineMathSelection(editor: SelectionSyncEditor): void {
  const { from, to, empty } = editor.state.selection;
  if (!selectionIntersectsInlineMath(editor, from, to, empty)) {
    return;
  }
  reconcilePendingGroups();

  const startGroup = ((): InlineMathGroup | null => {
    const paragraph = findParagraphElementForPos(editor, from);
    return paragraph !== null ? (groupByParagraph.get(paragraph) ?? null) : null;
  })();
  const endGroup = ((): InlineMathGroup | null => {
    if (empty || from === to) {
      return null;
    }
    const paragraph = findParagraphElementForPos(editor, to);
    return paragraph !== null ? (groupByParagraph.get(paragraph) ?? null) : null;
  })();

  const anchor = inlineMathScrollAnchorProvider?.capture() ?? null;
  try {
    withInlineMathActivationMeasurement(() => {
      const seen = new Set<string>();
      for (const group of [startGroup, endGroup]) {
        if (!group || seen.has(group.key)) {
          continue;
        }
        seen.add(group.key);
        activateGroup(group);
        for (const registration of group.formulas) {
          const position = registration.getPos();
          if (position === null) {
            continue;
          }
          const mathNode = editor.state.doc.nodeAt(position);
          const end = mathNode ? position + mathNode.nodeSize : position + 1;
          const selected = empty
            ? from > position && from < end
            : Math.max(from, position) < Math.min(to, end);
          registration.editing = selected;
        }
      }
    });
  } finally {
    if (anchor !== null) {
      inlineMathScrollAnchorProvider?.restore(anchor);
    }
  }
}

export function setInlineMathPrefetchRequester(
  requester: ((entries: FormulaIndexEntry[]) => void) | null,
): void {
  prefetchRequester = requester;
}

export function clearPendingInlineMathHeightMeasurements(): void {
  pendingHeightMeasurements.clear();
}

export function getInlineMathHeightPrefetchStatsForTest(): {
  groups: number;
  registeredFormulaKeys: number;
  preparedFormulaHtml: number;
  preparedFragments: number;
  pendingHeightMeasurements: number;
  heightCacheCoverage: number;
  placeholderRegistrations: number;
} {
  let heightCacheCoverage = 0;
  let placeholderRegistrations = 0;
  for (const group of groups.values()) {
    for (const registration of group.formulas) {
      if (registration.destroyed) {
        continue;
      }
      if (getCachedNodeHeight(registration.heightKey()) !== null) {
        heightCacheCoverage += 1;
      }
      if (registration.placeholderHeightKey !== null) {
        placeholderRegistrations += 1;
      }
    }
  }
  return {
    groups: groups.size,
    registeredFormulaKeys: inlineMathRegistrationsByFormulaKey.size,
    preparedFormulaHtml: preparedFormulaHtml.size,
    preparedFragments: preparedFormulaFragments.size,
    pendingHeightMeasurements: pendingHeightMeasurements.size,
    heightCacheCoverage,
    placeholderRegistrations,
  };
}

export function resetInlineMathGroupRegistryForTest(): void {
  resetFormulaTemplateCacheForTest();
  preparedFormulaFragments.clear();
  for (const group of Array.from(groups.values())) {
    if (group.observedElement !== null) {
      unregisterIoPlaceholder(group.id);
    }
    group.observedElement = null;
    if (group.paragraph !== null) {
      groupByParagraph.delete(group.paragraph);
    }
  }
  groups.clear();
  pendingGroups.clear();
  inlineGroupPositionTree = null;
  inlineGroupPositionIndex.clear();
  inlineGroupPositionDirty.clear();
  inlineGroupPositionCount = 0;
  sortedGroups = [];
  sortDirty = true;
  inlineMathGroupIndexTestCounters.sorts = 0;
  inlineMathGroupIndexTestCounters.rangeQueries = 0;
  inlineMathGroupIndexTestCounters.fullGroupScans = 0;
  pendingHeightMeasurements.clear();
  placeholderRegistrationsByHeightKey.clear();
  inlineMathRegistrationsByFormulaKey.clear();
  preparedFormulaHtml.clear();
  inlineMathActivationMaxFrameMs = 0;
  inlineMathActivationFrameStart = null;
  inlineMathScrollAnchorProvider = null;
  lastHydrateCenter = null;
  lastHydrateRadius = null;
  lastHydratePendingCount = null;
  lastHydrateActivated = null;
  unsubscribeHeightCacheSeeded();
  unsubscribeHeightCacheSeeded = subscribeNodeHeightCacheSeeded(refreshPlaceholderHeights);
  unsubscribeHeightCacheInvalidation();
  unsubscribeHeightCacheInvalidation = subscribeNodeHeightCacheInvalidation(() => {
    placeholderRegistrationsByHeightKey.clear();
    for (const group of groups.values()) {
      for (const registration of group.formulas) {
        addPlaceholderRegistration(registration);
      }
    }
  });
  prefetchRequester = null;
  setForceHydrateAllInlineMathGroups(forceHydrateAllInlineMathGroups);
  publishInlineMathActivationMetrics();
}

export function getInlineMathGroupCountForTest(): number {
  return groups.size;
}

export function getInlineMathGroupIndexTestCountersForTest(): InlineMathGroupIndexTestCounters {
  return { ...inlineMathGroupIndexTestCounters };
}
