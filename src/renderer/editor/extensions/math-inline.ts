import { InputRule, Node, mergeAttributes } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import katex from 'katex';
import { getCachedFormulaHtml, getFormulaCacheKey, seedFormulaHtmlCache } from '../math-render-cache';
import { getCachedNodeHeight, getHeightCacheKey, setCachedNodeHeight } from '../virtualization/height-cache';
import {
  forceActivate,
  registerVirtualNodeView,
} from '../virtualization/activation-controller';
import { translate } from '../../i18n';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mathInline: {
      insertInlineMath: (value?: string) => ReturnType;
    };
    mathBlock: {
      insertMathBlock: (value?: string) => ReturnType;
    };
  }
}

// Debug flag — toggle via localStorage.setItem('__mathDebug','1') in DevTools.
let __mathDebug = false;
try { __mathDebug = localStorage.getItem('__mathDebug') === '1'; } catch {}
function mathLog(...args: unknown[]): void {
  if (__mathDebug) console.log('[math]', ...args);
}

interface MathNodeLike {
  type: { name: string };
  textContent: string;
  nodeSize: number;
}

const BLOCK_MATH_DEFAULT_HEIGHT = 96;
const BLOCK_MATH_WIDTH_BUCKET = 160;
let blockMathNodeViewId = 0;

function nextBlockMathNodeViewId(): string {
  blockMathNodeViewId += 1;
  return `block-math-${blockMathNodeViewId}`;
}

function getBlockMathThemeKey(): string {
  const root = document.documentElement;
  const theme = root.dataset.theme ?? 'light';
  const palette = root.dataset.colorScheme ?? 'default';
  return `${theme}:${palette}`;
}

function getBlockMathZoomKey(): number {
  if (typeof window === 'undefined') return 1;
  return window.devicePixelRatio || 1;
}

function getBlockMathFontVersionKey(): string {
  const root = document.documentElement;
  if (root.dataset.fontVersion) return root.dataset.fontVersion;
  try {
    const font = getComputedStyle(root).getPropertyValue('--ui-font').trim();
    if (font) return font;
  } catch {}
  return 'default';
}

function getBlockMathWidthBucket(element: HTMLElement): number {
  const frame = element.closest('.editor-frame') as HTMLElement | null;
  const editorSurface = frame?.querySelector('.ProseMirror') as HTMLElement | null;
  const width = editorSurface?.clientWidth || frame?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0) || 800;
  return Math.max(1, Math.floor(width / BLOCK_MATH_WIDTH_BUCKET));
}

function getBlockMathHeightKey(node: MathNodeLike, element: HTMLElement): string {
  return getHeightCacheKey(
    node.type.name,
    node.textContent,
    getBlockMathWidthBucket(element),
    getBlockMathThemeKey(),
    getBlockMathZoomKey(),
    getBlockMathFontVersionKey(),
  );
}

function findMathCaretPosition(doc: any, from: number, display: string, value: string): number | null {
  let caret: number | null = null;
  doc.descendants((node: any, pos: number) => {
    if (caret !== null) return false;
    if (node.type.name !== 'inlineMath' || node.attrs.display !== display || pos < from) {
      return caret === null;
    }
    const text = node.textContent;
    const matches = value ? text === value : text.trim() === '';
    if (matches) {
      caret = pos + 1 + text.length;
      return false;
    }
    return true;
  });
  return caret;
}

export const MathInline = Node.create({
  name: 'inlineMath',
  group: 'inline',
  inline: true,
  selectable: true,
  atom: false,

  addOptions() {
    return {
      evaluation: false,
    };
  },

  addAttributes() {
    return {
      display: {
        default: 'no', // 'yes' or 'no'
      },
      evaluate: {
        default: 'no',
      },
      // Preserve original delimiter style through parse ↔ serialize round-trips
      // (`$...$`, `\(...\)`, `$$...$$`, `\[...\]`).
      openDelim: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-open-delim'),
        renderHTML: (attributes) =>
          attributes.openDelim ? { 'data-open-delim': attributes.openDelim } : {},
      },
      closeDelim: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-close-delim'),
        renderHTML: (attributes) =>
          attributes.closeDelim ? { 'data-close-delim': attributes.closeDelim } : {},
      },
    };
  },

  content: 'text*',

  parseHTML() {
    return [
      {
        tag: 'span[data-type="inlineMath"]',
        getAttrs: (element) => ({
          display: element.getAttribute('data-display') ?? 'no',
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      node.attrs.display === 'yes' ? 'div' : 'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'inlineMath',
        'data-display': node.attrs.display,
      }),
      0,
    ];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const isBlock = node.attrs.display === 'yes';

      // Create container
      const dom = document.createElement(isBlock ? 'div' : 'span');
      dom.className = isBlock ? 'math-block-node math-node-wrapper' : 'math-inline-node math-node-wrapper';
      const nodeViewId = nextBlockMathNodeViewId();
      let unregisterActivation: (() => void) | null = null;
      let blockPreviewActive = false;

      // Create editable content element
      const contentDOM = document.createElement('span');
      contentDOM.className = 'math-node-content';
      contentDOM.setAttribute('spellcheck', 'false');

      // Create preview element
      const previewDOM = document.createElement('span');
      previewDOM.className = 'math-node-preview';
      previewDOM.setAttribute('contenteditable', 'false');

      dom.appendChild(contentDOM);
      dom.appendChild(previewDOM);

      // Cache last rendered text to skip redundant KaTeX renders.
      let lastRenderedText: string | null = null;
      let destroyed = false;

      const getBlockPreviewHeight = (): number => {
        const cachedHeight = getCachedNodeHeight(getBlockMathHeightKey(node, dom));
        return cachedHeight ?? BLOCK_MATH_DEFAULT_HEIGHT;
      };

      const showBlockPlaceholder = (): void => {
        blockPreviewActive = false;
        lastRenderedText = null;
        dom.classList.add('math-block-node-placeholder');
        previewDOM.style.minHeight = `${getBlockPreviewHeight()}px`;
        previewDOM.replaceChildren();
        const hint = document.createElement('span');
        hint.className = 'math-node-placeholder-hint';
        hint.textContent = translate('emptyMath');
        previewDOM.appendChild(hint);
      };

      const doRender = (text: string) => {
        if (text === lastRenderedText) return;
        lastRenderedText = text;
        if (!text.trim()) {
          previewDOM.replaceChildren();
          const hint = document.createElement('span');
          hint.className = 'math-node-empty-hint';
          hint.textContent = translate('emptyMath');
          previewDOM.appendChild(hint);
          return;
        }
        try {
          const display = isBlock ? 'yes' : 'no';
          const cachedHtml = getCachedFormulaHtml(text, display);
          if (cachedHtml !== null) {
            previewDOM.innerHTML = cachedHtml;
            mathLog('cached:', text, 'children:', previewDOM.childNodes.length);
            return;
          }
          const html = katex.renderToString(text, {
            displayMode: isBlock,
            throwOnError: false,
            strict: 'ignore',
            output: 'html',
          });
          previewDOM.innerHTML = html;
          seedFormulaHtmlCache({
            [getFormulaCacheKey(text, display)]: html,
          });
          mathLog('rendered:', text, 'children:', previewDOM.childNodes.length);
        } catch (err) {
          previewDOM.textContent = text;
          mathLog('render error:', err);
        }
      };

      const renderPreview = (text: string) => {
        doRender(text);
      };

      const getBlockPreviewLayoutHeight = (): number => {
        const rectHeight = previewDOM.getBoundingClientRect().height;
        if (rectHeight > 0) {
          return rectHeight;
        }
        const minHeight = Number.parseFloat(previewDOM.style.minHeight);
        return Number.isFinite(minHeight) && minHeight > 0 ? minHeight : BLOCK_MATH_DEFAULT_HEIGHT;
      };

      const measureAndCacheBlockPreview = (): number => {
        const key = getBlockMathHeightKey(node, dom);
        const previousMinHeight = previewDOM.style.minHeight;
        previewDOM.style.minHeight = '0px';
        const height = Math.max(
          previewDOM.getBoundingClientRect().height,
          previewDOM.scrollHeight,
          previewDOM.clientHeight,
        );
        if (height > 0) {
          previewDOM.style.minHeight = `${height}px`;
          setCachedNodeHeight(key, height);
          return height;
        }
        if (previousMinHeight) {
          previewDOM.style.minHeight = previousMinHeight;
          return Number.parseFloat(previousMinHeight) || BLOCK_MATH_DEFAULT_HEIGHT;
        }
        previewDOM.style.minHeight = `${BLOCK_MATH_DEFAULT_HEIGHT}px`;
        return BLOCK_MATH_DEFAULT_HEIGHT;
      };

      const isBlockMathSelected = (): boolean => {
        if (typeof getPos !== 'function') return false;
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

      const isBlockMathSubmenuOpen = (): boolean => {
        const popup = document.querySelector<HTMLElement>('.math-completion');
        return popup !== null && popup.style.display !== 'none';
      };

      const shouldDeactivateBlockPreview = (): boolean => {
        if (dom.classList.contains('is-editing')) return false;
        if (editor.view.composing) return false;
        if (dom.contains(document.activeElement)) return false;
        if (isBlockMathSelected()) return false;
        if (isBlockMathSubmenuOpen()) return false;
        return true;
      };

      const compensateBlockPreviewScroll = (previousHeight: number): void => {
        const realHeight = measureAndCacheBlockPreview();
        if (realHeight === previousHeight) {
          return;
        }
        if (!shouldDeactivateBlockPreview()) {
          return;
        }
        const frame = dom.closest('.editor-frame') as HTMLElement | null;
        if (!frame) {
          return;
        }
        const frameRect = frame.getBoundingClientRect();
        const nodeRect = dom.getBoundingClientRect();
        if (nodeRect.bottom >= frameRect.top) {
          return;
        }
        const delta = realHeight - previousHeight;
        const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
        frame.scrollTop = Math.max(0, Math.min(frame.scrollTop + delta, maxScrollTop));
      };

      const activateBlockPreview = (): void => {
        const previousHeight = getBlockPreviewLayoutHeight();
        dom.classList.remove('math-block-node-placeholder');
        blockPreviewActive = true;
        renderPreview(node.textContent);
        compensateBlockPreviewScroll(previousHeight);
      };

      // Handle clicking anywhere on the formula to enter edit mode.
      // The is-editing class is managed by the MathFocusDecoration plugin,
      // so the node view no longer needs to subscribe to editor events.
      dom.addEventListener('click', (event) => {
        if (!editor.isEditable) return;
        if (typeof getPos !== 'function') return;
        if (dom.classList.contains('is-editing')) return;

        const pos = getPos();
        editor.chain().setTextSelection(pos + 1).focus().run();
        activateBlockPreview();
        event.preventDefault();
        event.stopPropagation();
      });

      mathLog('nodeView created:', node.textContent);
      if (isBlock) {
        showBlockPlaceholder();
        unregisterActivation = registerVirtualNodeView(
          nodeViewId,
          dom,
          {
            activate: activateBlockPreview,
            deactivate: showBlockPlaceholder,
            shouldDeactivate: shouldDeactivateBlockPreview,
          },
          {
            nodeType: 'inlineMath',
            contentHash: () => `${node.attrs.display}:${node.textContent}`,
            heightKey: () => getBlockMathHeightKey(node, dom),
            getPosition: () => {
              try {
                return getPos?.() ?? null;
              } catch {
                return null;
              }
            },
          },
        );
        if (isBlockMathSelected()) {
          forceActivate(nodeViewId);
        }
      } else {
        renderPreview(node.textContent);
      }

      return {
        dom,
        contentDOM,
        update(newNode) {
          if (newNode.type !== node.type) return false;
          if (newNode.attrs.display !== node.attrs.display) return false;
          const textChanged = newNode.textContent !== node.textContent;
          node = newNode;
          if (textChanged) {
            lastRenderedText = isBlock ? null : '';
          }
          if (isBlock) {
            if (blockPreviewActive) {
              renderPreview(node.textContent);
              measureAndCacheBlockPreview();
            } else if (isBlockMathSelected()) {
              activateBlockPreview();
            } else {
              showBlockPlaceholder();
            }
          } else {
            renderPreview(node.textContent);
          }
          return true;
        },
        selectNode() {
          if (isBlock) {
            activateBlockPreview();
          }
        },
        deselectNode() {},
        destroy() {
          destroyed = true;
          unregisterActivation?.();
        },
      };
    };
  },

  addCommands() {
    return {
      insertInlineMath:
        (value = '') =>
        ({ state, tr, dispatch }) => {
          const initialValue = value || ' ';
          const mathNode = state.schema.nodes.inlineMath?.create(
            { display: 'no', openDelim: '$', closeDelim: '$' },
            state.schema.text(initialValue)
          );
          if (!mathNode) {
            return false;
          }

          const { from, to } = state.selection;
          tr = tr.replaceWith(from, to, mathNode);
          const caret = value
            ? findMathCaretPosition(tr.doc, from, 'no', value) ?? from + 1 + value.length
            : from + 1;
          tr = tr.setSelection(TextSelection.create(tr.doc, caret));

          if (dispatch) {
            dispatch(tr.scrollIntoView());
          }

          return true;
        },

      insertMathBlock:
        (value = '') =>
        ({ state, tr, dispatch }) => {
          const mathNode = state.schema.nodes.inlineMath?.create(
            { display: 'yes', openDelim: '$$', closeDelim: '$$' },
            value ? state.schema.text(value) : undefined
          );
          if (!mathNode) {
            return false;
          }

          const paragraphNode = state.schema.nodes.paragraph?.create();
          if (!paragraphNode) {
            return false;
          }

          const { from, to } = state.selection;
          tr = tr.replaceWith(from, to, mathNode);

          const paragraphPos = from + mathNode.nodeSize;
          tr = tr.insert(paragraphPos, paragraphNode);
          const caret = findMathCaretPosition(tr.doc, from, 'yes', value) ?? from + 1 + value.length;
          tr = tr.setSelection(TextSelection.create(tr.doc, caret));

          if (dispatch) {
            dispatch(tr.scrollIntoView());
          }

          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const { state } = this.editor;
        const { selection } = state;
        const { $from, empty } = selection;

        if (!empty) return false;

        if ($from.parent.type.name === 'inlineMath') {
          const isBlock = $from.parent.attrs.display === 'yes';
          const delim = isBlock ? '$$' : '$';

          if ($from.parent.textContent.trim() === '' && $from.parentOffset === 0) {
            return this.editor.commands.command(({ tr, dispatch }) => {
              const pos = $from.before();
              if (dispatch) {
                tr.delete(pos, pos + $from.parent.nodeSize);
                dispatch(tr.scrollIntoView());
              }
              return true;
            });
          }

          if ($from.parentOffset === 0) {
            return this.editor.commands.command(({ tr, dispatch }) => {
              const pos = $from.before();
              const textContent = $from.parent.textContent;
              const replacementText = `${delim}${textContent}${delim}`;
              const textNode = state.schema.text(replacementText);

              if (dispatch) {
                tr.replaceWith(pos, pos + $from.parent.nodeSize, textNode);
                tr.setSelection(TextSelection.create(tr.doc, pos + delim.length));
                dispatch(tr.scrollIntoView());
              }
              return true;
            });
          }
        }
        return false;
      },

      ArrowRight: () => {
        const { state } = this.editor;
        const { selection } = state;
        const { $from, empty } = selection;

        if (!empty) return false;

        const nextNode = $from.nodeAfter;
        if (nextNode && nextNode.type.name === 'inlineMath') {
          return this.editor.commands.command(({ tr, dispatch }) => {
            if (dispatch) {
              tr.setSelection(TextSelection.create(tr.doc, $from.pos + 1));
              dispatch(tr.scrollIntoView());
            }
            return true;
          });
        }
        return false;
      },

      ArrowLeft: () => {
        const { state } = this.editor;
        const { selection } = state;
        const { $from, empty } = selection;

        if (!empty) return false;

        const prevNode = $from.nodeBefore;
        if (prevNode && prevNode.type.name === 'inlineMath') {
          return this.editor.commands.command(({ tr, dispatch }) => {
            if (dispatch) {
              tr.setSelection(TextSelection.create(tr.doc, $from.pos - 1));
              dispatch(tr.scrollIntoView());
            }
            return true;
          });
        }
        return false;
      },

      Enter: () => {
        const { state } = this.editor;
        const { selection } = state;
        const { $from } = selection;

        if (!selection.empty || $from.parent.type.name !== 'paragraph') {
          return false;
        }

        if ($from.parent.textContent.trim() !== '$$') {
          return false;
        }

        const from = $from.before();
        const to = from + $from.parent.nodeSize;

        return this.editor.commands.command(({ tr, dispatch }) => {
          const node = state.schema.nodes.inlineMath?.create(
            { display: 'yes', openDelim: '$$', closeDelim: '$$' }
          );
          if (!node) {
            return false;
          }

          if (dispatch) {
            tr = tr.replaceWith(from, to, node);
            const caret = findMathCaretPosition(tr.doc, from, 'yes', '') ?? from + 1;
            tr = tr.setSelection(TextSelection.create(tr.doc, caret));
            dispatch(tr.scrollIntoView());
          }

          return true;
        });
      },
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: /(?<![\\$])\$([^$\n]+)\$$/,
        handler: ({ chain, range, match }) => {
          const value = String(match[1] ?? '').trim();
          if (!value) return;

          const mathNode = this.editor.state.schema.nodes.inlineMath?.create(
            { display: 'no', openDelim: '$', closeDelim: '$' },
            value ? this.editor.state.schema.text(value) : undefined
          );
          if (!mathNode) return;

          chain()
            .command(({ tr, dispatch }) => {
              const { from, to } = range;
              tr = tr.replaceWith(from, to, mathNode);
              const caret = findMathCaretPosition(tr.doc, from, 'no', value) ?? from + 1 + value.length;
              tr = tr.setSelection(TextSelection.create(tr.doc, caret));
              if (dispatch) {
                dispatch(tr.scrollIntoView());
              }
              return true;
            })
            .run();
        },
      }),
      new InputRule({
        find: /^\$\$([^\n]*)\$\$$/,
        handler: ({ chain, range, match }) => {
          const value = String(match[1] ?? '').trim();

          const mathNode = this.editor.state.schema.nodes.inlineMath?.create(
            { display: 'yes', openDelim: '$$', closeDelim: '$$' },
            value ? this.editor.state.schema.text(value) : undefined
          );
          if (!mathNode) return;

          chain()
            .command(({ tr, dispatch }) => {
              const { from, to } = range;
              tr = tr.replaceWith(from, to, mathNode);
              const caret = findMathCaretPosition(tr.doc, from, 'yes', value) ?? from + 1 + value.length;
              tr = tr.setSelection(TextSelection.create(tr.doc, caret));
              if (dispatch) {
                dispatch(tr.scrollIntoView());
              }
              return true;
            })
            .run();
        },
      }),
    ];
  },
});
