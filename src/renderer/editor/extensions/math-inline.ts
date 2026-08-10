import { InputRule, Node, mergeAttributes } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import katex from 'katex';
import { getCachedFormulaHtml, getFormulaCacheKey, seedFormulaHtmlCache } from '../math-render-cache';
import {
  getCachedNodeHeight,
  getCachedNodeWidth,
  subscribeNodeHeightCacheSeeded,
} from '../virtualization/height-cache';
import { getFormulaHeightKey } from '../virtualization/height-measurer';
import {
  forceActivate,
  registerVirtualNodeView,
} from '../virtualization/activation-controller';
import {
  getPreparedInlineFormulaFragment,
  getPreparedInlineFormulaHtml,
  registerInlineMathNode,
  scheduleInlineMathHeightMeasurement,
  syncInlineMathPlaceholderKey,
  type InlineMathRegistration,
} from '../virtualization/inline-math-group-registry';
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

interface BlockMathPlaceholderView {
  dom: HTMLElement;
  preview: HTMLElement;
  getKey: () => string;
}

const blockMathPlaceholderViews = new Set<BlockMathPlaceholderView>();

function refreshBlockMathPlaceholderHeights(): void {
  for (const view of blockMathPlaceholderViews) {
    if (!view.dom.classList.contains('math-block-node-placeholder')) {
      continue;
    }
    const height = getCachedNodeHeight(view.getKey());
    if (height !== null) {
      view.preview.style.boxSizing = 'border-box';
      view.preview.style.overflow = 'hidden';
      view.preview.style.height = `${height}px`;
      view.preview.style.minHeight = `${height}px`;
    }
  }
}

subscribeNodeHeightCacheSeeded(refreshBlockMathPlaceholderHeights);

interface MathNodeLike {
  type: { name: string };
  textContent: string;
  nodeSize: number;
  attrs?: { display?: string };
}

const BLOCK_MATH_DEFAULT_HEIGHT = 96;
const INLINE_MATH_DEFAULT_HEIGHT = 35;
let blockMathNodeViewId = 0;

function nextBlockMathNodeViewId(): string {
  blockMathNodeViewId += 1;
  return `block-math-${blockMathNodeViewId}`;
}

function getBlockMathHeightKey(node: MathNodeLike, element: HTMLElement): string {
  return getFormulaHeightKey(
    node.textContent,
    node.attrs?.display === 'yes' ? 'yes' : 'no',
    element,
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
      let unregisterInlineGroup: (() => void) | null = null;
      let inlineRegistration: InlineMathRegistration | null = null;
      let inlinePreviewActive = false;
      let blockPreviewActive = false;

      // Create editable content element
      const contentDOM = document.createElement('span');
      contentDOM.className = 'math-node-content';
      contentDOM.setAttribute('spellcheck', 'false');

      // Create preview element
      const previewDOM = document.createElement('span');
      previewDOM.className = 'math-node-preview';
      previewDOM.setAttribute('contenteditable', 'false');
      const placeholderView: BlockMathPlaceholderView = {
        dom,
        preview: previewDOM,
        getKey: () => getBlockMathHeightKey(node, dom),
      };
      blockMathPlaceholderViews.add(placeholderView);

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
        const blockPreviewHeight = getBlockPreviewHeight();
        previewDOM.style.boxSizing = 'border-box';
        previewDOM.style.overflow = 'hidden';
        previewDOM.style.height = `${blockPreviewHeight}px`;
        previewDOM.style.minHeight = `${blockPreviewHeight}px`;
        previewDOM.replaceChildren();
        const hint = document.createElement('span');
        hint.className = 'math-node-placeholder-hint';
        hint.textContent = translate('emptyMath');
        previewDOM.appendChild(hint);
      };

      const buildPreviewFragment = (text: string): DocumentFragment => {
        const fragment = document.createDocumentFragment();
        if (!text.trim()) {
          const hint = document.createElement('span');
          hint.className = 'math-node-empty-hint';
          hint.textContent = translate('emptyMath');
          fragment.appendChild(hint);
          return fragment;
        }

        try {
          const display = isBlock ? 'yes' : 'no';
          const cachedHtml =
            getCachedFormulaHtml(text, display) ??
            getPreparedInlineFormulaHtml(getFormulaCacheKey(text, display));
          let html: string;
          if (cachedHtml !== null) {
            html = cachedHtml;
            mathLog('cached:', text, 'children:', html.length);
          } else {
            html = katex.renderToString(text, {
              displayMode: isBlock,
              throwOnError: false,
              strict: 'ignore',
              output: 'html',
            });
            seedFormulaHtmlCache({
              [getFormulaCacheKey(text, display)]: html,
            });
            mathLog('rendered:', text, 'children:', html.length);
          }

          const template = document.createElement('template');
          template.innerHTML = html;
          fragment.append(...Array.from(template.content.childNodes));
          return fragment;
        } catch (err) {
          fragment.appendChild(document.createTextNode(text));
          mathLog('render error:', err);
        }

        return fragment;
      };

      const renderPreview = (text: string) => {
        if (text === lastRenderedText) return;
        lastRenderedText = text;
        const display = isBlock ? 'yes' : 'no';
        const cacheKey = getFormulaCacheKey(text, display);
        const cachedHtml =
          getCachedFormulaHtml(text, display) ?? getPreparedInlineFormulaHtml(cacheKey);
        if (cachedHtml !== null) {
          const preparedFragment = getPreparedInlineFormulaFragment(cacheKey);
          if (preparedFragment !== null) {
            previewDOM.replaceChildren(preparedFragment);
          } else {
            previewDOM.innerHTML = cachedHtml;
          }
          return;
        }
        previewDOM.replaceChildren(buildPreviewFragment(text));
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

      const activateBlockPreview = (): void => {
        const cachedHeight = getCachedNodeHeight(getBlockMathHeightKey(node, dom));
        dom.classList.remove('math-block-node-placeholder');
        blockPreviewActive = true;
        renderPreview(node.textContent);
        const activeHeight = cachedHeight ?? BLOCK_MATH_DEFAULT_HEIGHT;
        previewDOM.style.boxSizing = 'border-box';
        previewDOM.style.overflow = 'visible';
        previewDOM.style.height = 'auto';
        previewDOM.style.minHeight = `${activeHeight}px`;
      };

      const getInlineMathPosition = (): number | null => {
        if (typeof getPos !== 'function') return null;
        try {
          return getPos();
        } catch {
          return null;
        }
      };

      const getInlineMathParagraphPosition = (): number | null => {
        const pos = getInlineMathPosition();
        if (pos === null) return null;
        try {
          const resolved = editor.state.doc.resolve(pos);
          return resolved.before(resolved.depth);
        } catch {
          return null;
        }
      };

      const getInlineHeightKey = (): string => getFormulaHeightKey(node.textContent, 'no', dom);

      const applyInlineSizing = (): void => {
        const inlineKey = getInlineHeightKey();
        const height = getCachedNodeHeight(inlineKey) ?? INLINE_MATH_DEFAULT_HEIGHT;
        const width = getCachedNodeWidth(inlineKey);
        previewDOM.style.display = 'inline-block';
        previewDOM.style.boxSizing = 'border-box';
        previewDOM.style.overflow = 'visible';
        previewDOM.style.height = 'auto';
        previewDOM.style.minHeight = `${height}px`;
        previewDOM.style.lineHeight = `${height}px`;
        previewDOM.style.whiteSpace = 'nowrap';
        previewDOM.style.verticalAlign = 'middle';
        if (width !== null) {
          previewDOM.style.minWidth = `${width}px`;
          previewDOM.style.maxWidth = `${width}px`;
          dom.style.minWidth = `${width}px`;
          dom.style.maxWidth = `${width}px`;
        }
        dom.style.overflow = 'visible';
        dom.style.height = 'auto';
        dom.style.minHeight = `${height}px`;
        dom.style.lineHeight = `${height}px`;
        dom.style.verticalAlign = 'middle';
      };

      const resetInlineActiveSizing = (): void => {
        previewDOM.style.overflow = 'visible';
        previewDOM.style.height = 'auto';
        dom.style.overflow = 'visible';
        dom.style.height = 'auto';
        dom.style.verticalAlign = 'baseline';
        previewDOM.style.verticalAlign = 'baseline';
        previewDOM.style.lineHeight = '';
        previewDOM.style.minHeight = '';
        previewDOM.style.minWidth = '';
        previewDOM.style.maxWidth = '';
        dom.style.lineHeight = '';
        dom.style.minHeight = '';
        dom.style.minWidth = '';
        dom.style.maxWidth = '';
      };

      const showInlinePlaceholder = (): void => {
        inlinePreviewActive = false;
        lastRenderedText = null;
        dom.classList.add('math-inline-node--placeholder');
        if (inlineRegistration) {
          syncInlineMathPlaceholderKey(inlineRegistration);
        }
        previewDOM.replaceChildren();
        const hint = document.createElement('span');
        hint.className = 'math-inline-placeholder-hint';
        hint.textContent = `$${node.textContent}$`;
        previewDOM.appendChild(hint);
        applyInlineSizing();
      };

      const activateInlinePreview = (): void => {
        inlinePreviewActive = true;
        dom.classList.remove('math-inline-node--placeholder');
        if (inlineRegistration) {
          syncInlineMathPlaceholderKey(inlineRegistration);
        }
        renderPreview(node.textContent);
        resetInlineActiveSizing();
        const cachedHtml = getCachedFormulaHtml(node.textContent, 'no');
        if (cachedHtml) {
          scheduleInlineMathHeightMeasurement(node.textContent, 'no', cachedHtml, dom);
        }
      };

      const deactivateInlinePreview = (): void => {
        // Once an inline formula has KaTeX in the DOM it stays active to avoid
        // a placeholder/KaTeX flicker when scrolling back to it.
      };

      const isInlineEditing = (): boolean => {
        if (editor.view.composing) return true;
        if (dom.contains(document.activeElement)) return true;
        if (dom.classList.contains('is-editing')) return true;
        return isBlockMathSelected();
      };

      const updateInlinePreview = (): void => {
        if (!inlineRegistration) {
          return;
        }
        inlineRegistration.editing = isInlineEditing();
        if (inlineRegistration.editing || inlinePreviewActive) {
          activateInlinePreview();
        } else {
          showInlinePlaceholder();
        }
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
        if (isBlock) {
          activateBlockPreview();
        } else {
          activateInlinePreview();
        }
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
        inlineRegistration = {
          id: nodeViewId,
          element: dom,
          preview: previewDOM,
          contentDOM,
          getPos: getInlineMathPosition,
          getParagraphPosition: getInlineMathParagraphPosition,
          getLatex: () => node.textContent,
          display: 'no',
          heightKey: getInlineHeightKey,
          activate: activateInlinePreview,
          deactivate: deactivateInlinePreview,
          update: updateInlinePreview,
          active: false,
          requested: false,
          editing: false,
          prepared: false,
          groupId: null,
          destroyed: false,
          placeholderHeightKey: null,
          formulaKey: null,
        };
        const editingNow = isInlineEditing();
        inlineRegistration.editing = editingNow;
        const frame = editor.view.dom.closest<HTMLElement>('.editor-frame');
        const lazyEnabled = frame !== null && typeof IntersectionObserver !== 'undefined';
        if (editingNow || !lazyEnabled) {
          activateInlinePreview();
        } else {
          showInlinePlaceholder();
        }
        (dom as HTMLElement & { __marivellInlineMathRegistration?: InlineMathRegistration }).__marivellInlineMathRegistration =
          inlineRegistration;
        unregisterInlineGroup = registerInlineMathNode(inlineRegistration);
      }

      return {
        dom,
        contentDOM,
        ignoreMutation(mutation) {
          return mutation.target !== contentDOM && !contentDOM.contains(mutation.target);
        },
        update(newNode) {
          if (newNode.type !== node.type) return false;
          if (newNode.attrs.display !== node.attrs.display) return false;
          const textChanged = newNode.textContent !== node.textContent;
          node = newNode;
          if (textChanged) {
            lastRenderedText = isBlock ? null : '';
            if (inlineRegistration) {
              inlineRegistration.formulaKey = null;
            }
          }
          if (isBlock) {
            if (blockPreviewActive) {
              renderPreview(node.textContent);
            } else if (isBlockMathSelected()) {
              activateBlockPreview();
            } else {
              showBlockPlaceholder();
            }
          } else {
            const editingNow = isInlineEditing();
            if (inlineRegistration) {
              inlineRegistration.editing = editingNow;
            }
            if (editingNow || inlinePreviewActive) {
              activateInlinePreview();
            } else if (textChanged) {
              showInlinePlaceholder();
            }
          }
          return true;
        },
        selectNode() {
          if (isBlock) {
            activateBlockPreview();
          } else if (inlineRegistration) {
            inlineRegistration.editing = true;
            activateInlinePreview();
          }
        },
        deselectNode() {},
        destroy() {
          destroyed = true;
          blockMathPlaceholderViews.delete(placeholderView);
          unregisterInlineGroup?.();
          unregisterInlineGroup = null;
          delete (dom as HTMLElement & { __marivellInlineMathRegistration?: InlineMathRegistration }).__marivellInlineMathRegistration;
          inlineRegistration = null;
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
