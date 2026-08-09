import { Node } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { registerVirtualNodeView } from '../virtualization/activation-controller';
import { getCachedNodeHeight, setCachedNodeHeight } from '../virtualization/height-cache';
import { getNodeHeightKey } from '../virtualization/height-measurer';

declare global {
  // Prevent TypeScript from widening string types
}

export interface HtmlBlockOptions {
  // No options needed for now
}

let htmlBlockNodeViewId = 0;

function nextHtmlBlockNodeViewId(): string {
  htmlBlockNodeViewId += 1;
  return `html-block-${htmlBlockNodeViewId}`;
}

export const HtmlBlock = Node.create<HtmlBlockOptions>({
  name: 'htmlBlock',

  group: 'block',

  atom: true,

  selectable: true,

  draggable: false,

  addAttributes() {
    return {
      html: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-html') ?? element.innerHTML,
        renderHTML: (attributes) => ({ 'data-html': attributes.html }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-html-block]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const html = String(HTMLAttributes['data-html'] ?? '');
    return [
      'div',
      {
        'data-html-block': '',
        class: 'html-block',
        contenteditable: 'false',
        ...HTMLAttributes,
      },
      // Use inner content via DOM manipulation in nodeView
      html,
    ];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div');
      dom.className = 'html-block';
      dom.setAttribute('data-html-block', '');
      dom.contentEditable = 'false';
      const nodeViewId = nextHtmlBlockNodeViewId();
      let unregisterActivation: (() => void) | null = null;
      let blockActive = false;

      const cacheCurrentHeight = (): void => {
        try {
          const height = dom.getBoundingClientRect().height || dom.scrollHeight;
          if (height > 0) {
            setCachedNodeHeight(
              getNodeHeightKey('htmlBlock', String(node.attrs.html ?? ''), dom),
              height,
            );
          }
        } catch {
          // jsdom has no real layout; active node views still measure in Chromium.
        }
      };

      const showPlaceholder = (): void => {
        blockActive = false;
        dom.classList.add('html-block-placeholder');
        dom.replaceChildren();
        const cachedHeight = getCachedNodeHeight(
          getNodeHeightKey('htmlBlock', String(node.attrs.html ?? ''), dom),
        );
        dom.style.minHeight = cachedHeight !== null ? `${cachedHeight}px` : '';
        const hint = document.createElement('span');
        hint.className = 'html-block-placeholder__hint';
        hint.textContent = 'HTML Block';
        dom.appendChild(hint);
      };

      const activate = (): void => {
        blockActive = true;
        dom.classList.remove('html-block-placeholder');
        dom.innerHTML = node.attrs.html ?? '';
        cacheCurrentHeight();
      };

      const isSelected = (): boolean => {
        if (typeof getPos !== 'function') {
          return false;
        }

        let pos = 0;
        try {
          pos = getPos();
        } catch {
          return false;
        }

        const { selection } = editor.state;
        if (selection instanceof NodeSelection) {
          return selection.from === pos && selection.to === pos + node.nodeSize;
        }
        if (selection.empty) {
          return selection.from > pos && selection.from < pos + node.nodeSize;
        }
        return Math.max(selection.from, pos) < Math.min(selection.to, pos + node.nodeSize);
      };

      const shouldDeactivate = (): boolean => {
        if (editor.view.composing) {
          return false;
        }
        if (dom.contains(document.activeElement)) {
          return false;
        }
        return !isSelected();
      };

      showPlaceholder();
      unregisterActivation = registerVirtualNodeView(
        nodeViewId,
        dom,
        {
          activate,
          deactivate: showPlaceholder,
          shouldDeactivate,
        },
        {
          nodeType: 'htmlBlock',
          contentHash: () => String(node.attrs.html ?? ''),
          getPosition: () => {
            try {
              return getPos?.() ?? null;
            } catch {
              return null;
            }
          },
        },
      );

      return {
        dom,
        contentDOM: undefined,
        update(updatedNode) {
          if (updatedNode.attrs.html !== node.attrs.html) {
            node = updatedNode;
            if (blockActive) {
              dom.innerHTML = node.attrs.html ?? '';
              cacheCurrentHeight();
            } else {
              showPlaceholder();
            }
            return true;
          }
          return false;
        },
        selectNode() {
          activate();
        },
        deselectNode() {},
        destroy() {
          unregisterActivation?.();
        },
      };
    };
  },
});
