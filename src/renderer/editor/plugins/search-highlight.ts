import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';

export interface SearchHighlightState {
  matches: Array<{ from: number; to: number }>;
  currentIndex: number;
  query: string;
}

function buildDecorations(state: SearchHighlightState): DecorationSet {
  const decorations: Decoration[] = [];

  state.matches.forEach((match, index) => {
    const isCurrent = index === state.currentIndex;
    decorations.push(
      Decoration.inline(match.from, match.to, {
        class: isCurrent ? 'search-highlight-current' : 'search-highlight',
      }),
    );
  });

  return DecorationSet.create(state.matches.length > 0 ? decorations[0]!.from : 0, decorations);
}

const searchHighlightKey = new PluginKey<SearchHighlightState>('searchHighlight');

function getDefaultState(): SearchHighlightState {
  return { matches: [], currentIndex: 0, query: '' };
}

export const SearchHighlight = Extension.create({
  name: 'searchHighlight',

  addStorage() {
    return {
      /**
       * Programmatically update search highlight decorations from outside
       * the editor. Call this whenever search matches or active index change.
       */
      updateHighlights: (matches: Array<{ from: number; to: number }>, currentIndex: number, query: string) => {
        const view = (this.editor as any)?.view as EditorView | undefined;
        if (!view) return;

        const state: SearchHighlightState = { matches, currentIndex, query };
        view.dispatch(view.state.tr.setMeta(searchHighlightKey, state));
      },

      /** Clear all search highlights */
      clearHighlights: () => {
        const view = (this.editor as any)?.view as EditorView | undefined;
        if (!view) return;

        const state: SearchHighlightState = { matches: [], currentIndex: 0, query: '' };
        view.dispatch(view.state.tr.setMeta(searchHighlightKey, state));
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<SearchHighlightState>({
        key: searchHighlightKey,

        state: {
          init(): SearchHighlightState {
            return getDefaultState();
          },
          apply(tr, prevState): SearchHighlightState {
            const meta = tr.getMeta(searchHighlightKey) as SearchHighlightState | undefined;
            if (meta) {
              return meta;
            }
            return prevState;
          },
        },

        props: {
          decorations(state) {
            const highlightState = searchHighlightKey.getState(state);
            if (!highlightState || highlightState.matches.length === 0) {
              return DecorationSet.empty;
            }
            return buildDecorations(highlightState);
          },
        },
      }),
    ];
  },
});
