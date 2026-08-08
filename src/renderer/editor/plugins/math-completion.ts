import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
  getMathCompletionCaret,
  getMathCompletionItems,
  type MathCompletionItem,
} from '../math-completions';

interface MathCompletionState {
  open: boolean;
  from: number;
  to: number;
  query: string;
  items: MathCompletionItem[];
  selectedIndex: number;
}

const mathCompletionKey = new PluginKey<MathCompletionState>('mathCompletion');

const EMPTY_STATE: MathCompletionState = {
  open: false,
  from: 0,
  to: 0,
  query: '',
  items: [],
  selectedIndex: 0,
};

function computeCompletionState(state: EditorState): MathCompletionState {
  const { selection } = state;
  if (!selection.empty || selection.$from.parent.type.name !== 'inlineMath') {
    return EMPTY_STATE;
  }

  const { $from } = selection;
  const start = $from.start();
  const text = state.doc.textBetween(start, $from.pos, '\n', '\n');
  const match = text.match(/(\\[A-Za-z]*)$/);
  if (!match) {
    return EMPTY_STATE;
  }

  const query = match[0].slice(1).toLowerCase();
  const items = getMathCompletionItems(query);
  if (items.length === 0) {
    return EMPTY_STATE;
  }

  return {
    open: true,
    from: $from.pos - match[0].length,
    to: $from.pos,
    query,
    items,
    selectedIndex: 0,
  };
}

function closeCompletion(view: EditorView): void {
  const tr = view.state.tr.setMeta(mathCompletionKey, { close: true });
  view.dispatch(tr);
  view.focus();
}

function acceptCompletion(view: EditorView): void {
  const state = mathCompletionKey.getState(view.state);
  if (!state?.open || state.items.length === 0) {
    return;
  }

  const item = state.items[Math.min(state.selectedIndex, state.items.length - 1)];
  const tr = view.state.tr.insertText(item.insert, state.from, state.to);
  const caret = state.from + getMathCompletionCaret(item.insert);
  tr.setSelection(TextSelection.create(tr.doc, caret));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

export const MathCompletion = Extension.create({
  name: 'mathCompletion',

  addProseMirrorPlugins() {
    return [
      new Plugin<MathCompletionState>({
        key: mathCompletionKey,
        state: {
          init() {
            return EMPTY_STATE;
          },
          apply(tr, old, _oldState, newState) {
            if (tr.getMeta(mathCompletionKey)?.close) {
              return EMPTY_STATE;
            }
            const selectIndex = tr.getMeta(mathCompletionKey)?.select;
            if (typeof selectIndex === 'number') {
              return { ...old, selectedIndex: selectIndex };
            }
            if (!tr.docChanged && !tr.selectionSet) {
              return old;
            }
            return computeCompletionState(newState);
          },
        },
        props: {
          handleKeyDown(view, event) {
            const state = mathCompletionKey.getState(view.state);
            if (!state?.open) {
              return false;
            }

            if (event.key === 'ArrowDown') {
              event.preventDefault();
              const next = (state.selectedIndex + 1) % state.items.length;
              view.dispatch(view.state.tr.setMeta(mathCompletionKey, { select: next }));
              return true;
            }

            if (event.key === 'ArrowUp') {
              event.preventDefault();
              const previous =
                (state.selectedIndex - 1 + state.items.length) % state.items.length;
              view.dispatch(view.state.tr.setMeta(mathCompletionKey, { select: previous }));
              return true;
            }

            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault();
              acceptCompletion(view);
              return true;
            }

            if (event.key === 'Escape') {
              event.preventDefault();
              closeCompletion(view);
              return true;
            }

            return false;
          },
        },
        view(view) {
          const popup = document.createElement('div');
          popup.className = 'math-completion';
          popup.style.display = 'none';
          document.body.appendChild(popup);

          const render = () => {
            const state = mathCompletionKey.getState(view.state);
            if (!state?.open || state.items.length === 0) {
              popup.style.display = 'none';
              return;
            }

            const coords = view.coordsAtPos(state.to);
            const width = Math.min(280, window.innerWidth - 16);
            const left = Math.max(8, Math.min(coords.left, window.innerWidth - width - 8));
            const estimatedHeight = Math.min(260, state.items.length * 36 + 12);
            let top = coords.bottom + 6;
            if (top + estimatedHeight > window.innerHeight - 8) {
              top = Math.max(8, coords.top - estimatedHeight - 6);
            }

            popup.style.display = 'block';
            popup.style.left = `${left}px`;
            popup.style.top = `${top}px`;
            popup.style.width = `${width}px`;
            popup.replaceChildren();

            state.items.forEach((item, index) => {
              const button = document.createElement('button');
              button.className = 'math-completion__item';
              button.dataset.index = String(index);
              button.type = 'button';
              button.textContent = item.label;
              if (index === state.selectedIndex) {
                button.classList.add('is-selected');
              }
              popup.appendChild(button);
            });
          };

          const handleOutsidePointer = (event: MouseEvent) => {
            const target = event.target as Node;
            if (view.dom.contains(target) || popup.contains(target)) {
              return;
            }
            const state = mathCompletionKey.getState(view.state);
            if (state?.open) {
              closeCompletion(view);
            }
          };

          document.addEventListener('mousedown', handleOutsidePointer, true);
          popup.addEventListener('mousedown', (event) => event.preventDefault());
          popup.addEventListener('click', (event) => {
            const target = event.target as HTMLElement;
            const item = target.closest('button');
            if (!item) {
              return;
            }
            const state = mathCompletionKey.getState(view.state);
            if (state?.items[Number(item.dataset.index)]) {
              acceptCompletion(view);
            }
          });

          return {
            update() {
              render();
            },
            destroy() {
              document.removeEventListener('mousedown', handleOutsidePointer, true);
              popup.remove();
            },
          };
        },
      }),
    ];
  },
});
