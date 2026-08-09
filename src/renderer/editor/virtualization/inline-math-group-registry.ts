import { getCachedFormulaHtml, getFormulaCacheKey } from '../math-render-cache';
import type { FormulaIndexEntry } from '../markdown.worker';
import {
  getCachedNodeHeight,
  notifyNodeHeightCacheSeeded,
  setCachedNodeHeight,
  subscribeNodeHeightCacheSeeded,
} from './height-cache';
import {
  buildFormulaHeightMeasurementItems,
  getFormulaHeightKey,
  measureFormulaHeights,
} from './height-measurer';

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
const registrations: InlineMathRegistration[] = [];
const paragraphGroupIds = new WeakMap<HTMLElement, number>();
const pendingHeightMeasurements = new Set<string>();
const layoutRetryFrames = new WeakMap<HTMLElement, number>();

let groupSeq = 0;
let paragraphGroupSeq = 0;
let registrationVersion = 0;
let builtRegistrationVersion = -1;
let prefetchRequester: ((entries: FormulaIndexEntry[]) => void) | null = null;
let activatingGroupId: string | null = null;

function refreshPlaceholderHeights(): void {
  for (const group of getBuiltGroups().values()) {
    for (const registration of group.formulas) {
      if (registration.active) {
        continue;
      }
      const height = getCachedNodeHeight(registration.heightKey());
      if (height === null) {
        continue;
      }
      registration.preview.style.minHeight = `${height}px`;
      registration.preview.style.lineHeight = `${height}px`;
    }
  }
}

let unsubscribeHeightCacheSeeded = subscribeNodeHeightCacheSeeded(refreshPlaceholderHeights);

function getRegistrationKey(registration: InlineMathRegistration): string {
  const paragraphElement = getParagraphElement(registration);
  if (paragraphElement) {
    let paragraphId = paragraphGroupIds.get(paragraphElement);
    if (paragraphId === undefined) {
      paragraphId = ++paragraphGroupSeq;
      paragraphGroupIds.set(paragraphElement, paragraphId);
    }
    return `el:${paragraphId}`;
  }
  return `node:${registration.id}`;
}

function getParagraphElement(registration: InlineMathRegistration): HTMLElement | null {
  const element = registration.element;
  if (!element.isConnected) {
    return null;
  }
  return element.closest<HTMLElement>(TEXTBLOCK_SELECTOR) ?? element.parentElement;
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
}

function updateGroupPosition(group: InlineMathGroup, registration: InlineMathRegistration): void {
  const position = registration.getPos();
  if (position === null) {
    return;
  }
  group.firstPmPos = Math.min(group.firstPmPos, position);
  group.lastPmPos = Math.max(group.lastPmPos, position);
}

function getGroupElement(group: InlineMathGroup): HTMLElement {
  return group.paragraph ?? group.element;
}

function observeGroup(group: InlineMathGroup): void {
  // Visibility is driven by the editor scroll rAF so structural transactions do
  // not pay for thousands of IntersectionObserver observe/unobserve calls.
}

function unobserveGroup(group: InlineMathGroup): void {
  group.observedElement = null;
}

function unregisterGroup(group: InlineMathGroup): void {
  unobserveGroup(group);
  groups.delete(group.key);
}

function refreshGroupParagraph(group: InlineMathGroup): void {
  const nextParagraph = Array.from(group.formulas).map(getParagraphElement).find(Boolean) ?? null;
  if (nextParagraph === group.paragraph) {
    return;
  }
  group.paragraph = nextParagraph;
  if (nextParagraph !== null) {
    group.element = nextParagraph;
  }
  observeGroup(group);
}

function addRegistrationToGroup(registration: InlineMathRegistration): InlineMathGroup {
  const key = getRegistrationKey(registration);
  let group = groups.get(key);
  if (!group) {
    group = {
      id: `inline-math-group-${++groupSeq}`,
      key,
      element: registration.element,
      paragraph: getParagraphElement(registration),
      formulas: new Set(),
      firstPmPos: Number.POSITIVE_INFINITY,
      lastPmPos: Number.NEGATIVE_INFINITY,
      active: false,
      requested: false,
      heightKnown: false,
      observedElement: null,
    };
    groups.set(key, group);
    if (group.paragraph !== null) {
      group.element = group.paragraph;
    }
  } else if (group.paragraph === null) {
    group.paragraph = getParagraphElement(registration);
    if (group.paragraph !== null) {
      group.element = group.paragraph;
    }
  }

  registration.groupId = group.key;
  group.formulas.add(registration);
  updateGroupPosition(group, registration);

  if (group.paragraph === null) {
    refreshGroupParagraph(group);
  }
  return group;
}

function removeRegistrationFromGroup(registration: InlineMathRegistration): void {
  if (!registration.groupId) {
    return;
  }
  const group = groups.get(registration.groupId);
  registration.groupId = null;
  if (!group) {
    return;
  }

  group.formulas.delete(registration);
  if (group.formulas.size === 0) {
    unregisterGroup(group);
    return;
  }

  const removed = registration;
  const removedPos = removed.getPos();
  if (
    removedPos !== null &&
    (removedPos === group.firstPmPos || removedPos === group.lastPmPos)
  ) {
    refreshGroupBounds(group);
  }
  refreshGroupParagraph(group);
}

function requestPrefetch(entries: FormulaIndexEntry[]): void {
  if (!entries.length || !prefetchRequester) {
    return;
  }

  const missing = new Map<string, FormulaIndexEntry>();
  for (const entry of entries) {
    const cacheKey = getFormulaCacheKey(entry.latex, entry.display);
    if (!missing.has(cacheKey)) {
      missing.set(cacheKey, entry);
    }
  }
  const missingEntries = Array.from(missing.values()).filter(
    (entry) => getCachedFormulaHtml(entry.latex, entry.display) === null,
  );
  if (missingEntries.length > 0) {
    prefetchRequester(missingEntries);
  }
}

function collectGroupFormulaEntries(group: InlineMathGroup): FormulaIndexEntry[] {
  return Array.from(group.formulas, (registration) => ({
    key: getFormulaCacheKey(registration.getLatex(), registration.display),
    latex: registration.getLatex(),
    display: registration.display,
  }));
}

function prepareGroup(group: InlineMathGroup): void {
  if (group.active) {
    return;
  }
  group.requested = true;
  for (const registration of group.formulas) {
    registration.requested = true;
    if (getCachedFormulaHtml(registration.getLatex(), registration.display) !== null) {
      registration.prepared = true;
    }
  }
  const entries = collectGroupFormulaEntries(group);
  requestPrefetch(entries.slice(0, Math.min(48, entries.length)));
}

function activateGroup(group: InlineMathGroup): void {
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
        registration.activate();
      }
      registration.requested = true;
    }
    requestPrefetch(collectGroupFormulaEntries(group).slice(0, 48));
  } finally {
    activatingGroupId = null;
  }
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

function markRegistrationGroupsStale(): void {
  registrationVersion += 1;
  groups.clear();
}

function getBuiltGroups(): Map<string, InlineMathGroup> {
  if (builtRegistrationVersion === registrationVersion) {
    return groups;
  }

  groups.clear();
  groupSeq = 0;
  for (const registration of registrations) {
    if (!registration.destroyed) {
      const key = getRegistrationKey(registration);
      let group = groups.get(key);
      if (!group) {
        group = {
          id: `inline-math-group-${++groupSeq}`,
          key,
          element: registration.element,
          paragraph: getParagraphElement(registration),
          formulas: new Set(),
          firstPmPos: Number.POSITIVE_INFINITY,
          lastPmPos: Number.NEGATIVE_INFINITY,
          active: registration.active,
          requested: registration.requested,
          heightKnown: false,
          observedElement: null,
        };
        groups.set(key, group);
        if (group.paragraph !== null) {
          group.element = group.paragraph;
        }
      } else if (group.paragraph === null) {
        group.paragraph = getParagraphElement(registration);
        if (group.paragraph !== null) {
          group.element = group.paragraph;
        }
      }
      registration.groupId = group.key;
      group.formulas.add(registration);
      updateGroupPosition(group, registration);
    }
  }
  builtRegistrationVersion = registrationVersion;
  return groups;
}

function getSortedGroups(): InlineMathGroup[] {
  return Array.from(getBuiltGroups().values()).sort(
    (left, right) => left.firstPmPos - right.firstPmPos,
  );
}

export function registerInlineMathNode(registration: InlineMathRegistration): () => void {
  registrations.push(registration);
  markRegistrationGroupsStale();

  let removed = false;
  return () => {
    if (removed) {
      return;
    }
    removed = true;
    registration.destroyed = true;
    markRegistrationGroupsStale();
  };
}

interface InlineMathEditorLike {
  state: {
    doc: {
      descendants: (fn: (node: { type: { name: string }; attrs?: { display?: string } }, pos: number) => boolean | void) => void;
    };
  };
  view: { nodeDOM: (pos: number) => Node | null };
}

export function registerInlineMathGroupsFromEditor(editor: InlineMathEditorLike): void {
  registrations.length = 0;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'inlineMath' || node.attrs?.display === 'yes') {
      return true;
    }
    const dom = editor.view.nodeDOM(pos);
    const registration = dom instanceof HTMLElement
      ? (dom as HTMLElement & { __marivellInlineMathRegistration?: InlineMathRegistration })
          .__marivellInlineMathRegistration
      : undefined;
    if (registration) {
      registrations.push(registration);
    }
    return true;
  });
  markRegistrationGroupsStale();
}

export function updateInlineMathRegistration(registration: InlineMathRegistration): void {
  markRegistrationGroupsStale();

  if (registration.active) {
    registration.requested = true;
    requestPrefetch([
      {
        key: getFormulaCacheKey(registration.getLatex(), registration.display),
        latex: registration.getLatex(),
        display: registration.display,
      },
    ]);
  }
}

export function activateInlineMathNode(registration: InlineMathRegistration): void {
  const group = registration.groupId ? groups.get(registration.groupId) : undefined;
  if (group) {
    activateGroup(group);
    return;
  }

  registration.active = true;
  registration.requested = true;
  registration.activate();
  requestPrefetch([
    {
      key: getFormulaCacheKey(registration.getLatex(), registration.display),
      latex: registration.getLatex(),
      display: registration.display,
    },
  ]);
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
): number {
  const sorted = getSortedGroups();
  if (!frame || typeof IntersectionObserver === 'undefined') {
    for (const group of sorted) {
      activateGroup(group);
    }
    return sorted.length;
  }

  let activated = 0;

  const firstGroup = sorted[0];
  const firstElement = firstGroup ? getGroupElement(firstGroup) : null;
  if (firstElement && firstElement.isConnected && firstElement.getBoundingClientRect().height <= 0) {
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
    return 0;
  }
  layoutRetryFrames.delete(frame);

  const frameRect = frame.getBoundingClientRect();
  const prefetchTop = frameRect.top - margin;
  const prefetchBottom = frameRect.bottom + margin;
  for (const group of sorted) {
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
      if (!group.active) {
        prepareGroup(group);
      }
      continue;
    }
    if (!group.active) {
      activateGroup(group);
      activated += 1;
    } else {
      group.requested = true;
      requestPrefetch(collectGroupFormulaEntries(group).slice(0, 48));
    }
  }

  return activated;
}

export function hydrateInlineMathGroupsAroundScrollRatio(
  frame: HTMLElement,
  scrollTop: number,
  maxScrollTop: number,
  margin = 1600,
): number {
  const sorted = getSortedGroups();
  if (sorted.length === 0 || !frame || typeof IntersectionObserver === 'undefined') {
    for (const group of sorted) {
      activateGroup(group);
    }
    return sorted.length;
  }

  const ratio = maxScrollTop > 0 ? Math.min(1, Math.max(0, scrollTop / maxScrollTop)) : 0;
  const centerIndex = Math.floor((sorted.length - 1) * ratio);
  const radius = Math.max(120, Math.floor(sorted.length * 0.22));
  const from = Math.max(0, centerIndex - radius);
  const to = Math.min(sorted.length, centerIndex + radius + 1);
  let activated = 0;

  for (let index = from; index < to; index += 1) {
    const group = sorted[index];
    if (!group || group.active) {
      continue;
    }
    const relation = getGroupViewportRelation(group, frame, margin);
    if (relation === 'visible') {
      activateGroup(group);
      activated += 1;
    } else if (relation === 'prefetch') {
      prepareGroup(group);
    }
  }

  return activated;
}

export function prepareInlineMathForFormulaHtml(htmlByKey: Record<string, string>): void {
  for (const group of getBuiltGroups().values()) {
    for (const registration of group.formulas) {
      const key = getFormulaCacheKey(registration.getLatex(), registration.display);
      const html = htmlByKey[key];
      if (typeof html !== 'string' || !html) {
        continue;
      }
      registration.prepared = true;
      if (registration.active) {
        scheduleInlineMathHeightMeasurement(
          registration.getLatex(),
          registration.display,
          html,
          registration.element,
        );
      }
    }
  }
}

export function scheduleInlineMathHeightMeasurement(
  latex: string,
  display: 'yes' | 'no',
  html: string,
  element?: HTMLElement | null,
): void {
  const heightKey = getFormulaHeightKey(latex, display, element);
  if (getCachedNodeHeight(heightKey) !== null || pendingHeightMeasurements.has(heightKey)) {
    return;
  }
  pendingHeightMeasurements.add(heightKey);

  const sourceKey = getFormulaCacheKey(latex, display);
  const items = buildFormulaHeightMeasurementItems(
    [{ key: sourceKey, latex, display }],
    { [sourceKey]: html },
    element,
  );
  if (items.length === 0) {
    pendingHeightMeasurements.delete(heightKey);
    return;
  }

  void measureFormulaHeights(items).then((heights) => {
    pendingHeightMeasurements.delete(heightKey);
    for (const [key, height] of Object.entries(heights)) {
      setCachedNodeHeight(key, height);
    }
    notifyNodeHeightCacheSeeded();
  });
}

interface SelectionSyncEditor {
  state: {
    selection: { from: number; to: number; empty: boolean };
    doc: { nodeAt: (pos: number) => { nodeSize: number } | null };
  };
}

export function syncInlineMathSelection(editor: SelectionSyncEditor): void {
  const { from, to, empty } = editor.state.selection;
  const sorted = getSortedGroups();
  if (sorted.length === 0) {
    return;
  }

  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (sorted[mid]!.lastPmPos < from) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  const group = sorted[low];
  if (!group || group.firstPmPos > to) {
    return;
  }

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

export function setInlineMathPrefetchRequester(
  requester: ((entries: FormulaIndexEntry[]) => void) | null,
): void {
  prefetchRequester = requester;
}

export function resetInlineMathGroupRegistryForTest(): void {
  for (const group of Array.from(groups.values())) {
    unregisterGroup(group);
  }
  groups.clear();
  registrations.length = 0;
  registrationVersion = 0;
  builtRegistrationVersion = -1;
  pendingHeightMeasurements.clear();
  unsubscribeHeightCacheSeeded();
  unsubscribeHeightCacheSeeded = subscribeNodeHeightCacheSeeded(refreshPlaceholderHeights);
  prefetchRequester = null;
}

export function getInlineMathGroupCountForTest(): number {
  return getBuiltGroups().size;
}
