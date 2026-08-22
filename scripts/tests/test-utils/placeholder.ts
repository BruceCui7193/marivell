import type { Page } from 'playwright-core';

export interface VisiblePlaceholderProbe {
  placeholderCount: number;
  visibleInlineMathCount: number;
  visibleRealKatexCount: number;
  visibleUnrenderedInlineMathCount: number;
  visiblePlaceholderInlineMathCount: number;
  visibleImageCount: number;
  visibleUnloadedImageCount: number;
  grayLatexDirectTextCount: number;
  placeholderDetails: Array<{
    type: string;
    className: string;
    text: string;
    html: string;
  }>;
}

export const PLACEHOLDER_HELPER_SOURCE = `(window => {
function marivellGetInlinePreview(element) {
  return element.querySelector(':scope > .math-node-preview');
}

function marivellIsInlineMathFinalState(preview) {
  return Boolean(
    preview &&
      preview.querySelector(
        '.katex-error, .math-node-empty-hint, .math-node-placeholder-hint',
      ),
  );
}

function marivellIsInlineMathRealKatex(element) {
  const preview = marivellGetInlinePreview(element);
  if (!preview) return false;
  if (!preview.querySelector('.katex')) return false;
  return !marivellIsInlineMathFinalState(preview);
}

function marivellHasDirectPreviewText(element) {
  const preview = marivellGetInlinePreview(element);
  if (!preview) return false;
  return Array.from(preview.childNodes).some(function (child) {
    return (
      child.nodeType === Node.TEXT_NODE &&
      Boolean((child.textContent || '').trim())
    );
  });
}

function marivellIsInlineMathPlaceholder(element) {
  if (element.classList.contains('math-inline-node--placeholder')) return true;
  const preview = marivellGetInlinePreview(element);
  if (!preview) return true;
  if (preview.querySelector('.math-inline-placeholder-hint')) return true;
  if (marivellIsInlineMathRealKatex(element)) return false;
  if (marivellIsInlineMathFinalState(preview)) return false;
  return true;
}

function marivellIntersectsFrame(frame, element) {
  const frameRect = frame.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return (
    rect.bottom > frameRect.top &&
    rect.top < frameRect.bottom &&
    rect.right > frameRect.left &&
    rect.left < frameRect.right
  );
}

function marivellCollectVisiblePlaceholderState(frame) {
  if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
  const richSelectors = [
    '.math-block-node-placeholder',
    '.image-node__placeholder',
    '.mermaid-node__placeholder',
    '.html-block-placeholder',
    '.code-block-node--placeholder',
    '.mermaid-node__empty',
  ];
  const placeholderElements = [];
  for (const selector of richSelectors) {
    for (const element of frame.querySelectorAll(selector)) {
      if (marivellIntersectsFrame(frame, element)) {
        placeholderElements.push({ type: 'rich-block', selector, element });
      }
    }
  }

  const inlineMath = [];
  for (const element of frame.querySelectorAll('.math-inline-node')) {
    if (!marivellIntersectsFrame(frame, element)) continue;
    const realKatex = marivellIsInlineMathRealKatex(element);
    const placeholder = marivellIsInlineMathPlaceholder(element);
    const directText = marivellHasDirectPreviewText(element);
    inlineMath.push({ element, realKatex, placeholder, directText });
    if (placeholder) {
      placeholderElements.push({
        type: 'inline-math',
        selector: '.math-inline-node',
        element,
      });
    }
  }

  const images = [];
  for (const element of frame.querySelectorAll('.image-node')) {
    if (!marivellIntersectsFrame(frame, element)) continue;
    const placeholder = Boolean(
      element.querySelector(':scope > .image-node__placeholder'),
    );
    const imageElements = Array.from(
      element.querySelectorAll('img.image-node__image'),
    );
    const loadedCount = imageElements.filter(
      (image) => image.complete && image.naturalWidth > 0,
    ).length;
    images.push({
      element,
      placeholder,
      imageCount: imageElements.length,
      loadedCount,
      unloadedCount: imageElements.length - loadedCount,
    });
  }

  const describeElement = (element) => ({
    type: '',
    className: String(element.className || ''),
    text: String(element.textContent || '').trim().slice(0, 80),
    html: element.outerHTML.slice(0, 200),
  });
  const placeholderDetails = placeholderElements.map((entry) => {
    const element = entry.element;
    return {
      type: entry.type,
      selector: entry.selector,
      ...describeElement(element),
    };
  });

  return {
    placeholderCount: placeholderElements.length,
    visibleInlineMathCount: inlineMath.length,
    visibleRealKatexCount: inlineMath.filter((item) => item.realKatex).length,
    visibleUnrenderedInlineMathCount: inlineMath.filter(
      (item) => !item.realKatex,
    ).length,
    visiblePlaceholderInlineMathCount: inlineMath.filter(
      (item) => item.placeholder,
    ).length,
    visibleImageCount: images.reduce(
      (total, item) => total + item.imageCount,
      0,
    ),
    visibleUnloadedImageCount: images.reduce(
      (total, item) => total + item.unloadedCount,
      0,
    ),
    grayLatexDirectTextCount: inlineMath.filter((item) => item.directText).length,
    placeholderDetails,
  };
}

window.marivellGetInlinePreview = marivellGetInlinePreview;
window.marivellIsInlineMathFinalState = marivellIsInlineMathFinalState;
window.marivellIsInlineMathRealKatex = marivellIsInlineMathRealKatex;
window.marivellHasDirectPreviewText = marivellHasDirectPreviewText;
window.marivellIsInlineMathPlaceholder = marivellIsInlineMathPlaceholder;
window.marivellIntersectsFrame = marivellIntersectsFrame;
window.marivellCollectVisiblePlaceholderState =
  marivellCollectVisiblePlaceholderState;
})(window);
`;

export async function installPlaceholderHelpers(page: Page): Promise<void> {
  await page.evaluate(PLACEHOLDER_HELPER_SOURCE);
}

export function getMarivellPlaceholderWindow(
  value: unknown,
): {
  marivellCollectVisiblePlaceholderState: (
    frame: HTMLElement,
  ) => VisiblePlaceholderProbe;
  marivellIsInlineMathPlaceholder: (element: HTMLElement) => boolean;
  marivellIsInlineMathRealKatex: (element: HTMLElement) => boolean;
  marivellHasDirectPreviewText: (element: HTMLElement) => boolean;
} {
  return value as ReturnType<typeof getMarivellPlaceholderWindow>;
}
