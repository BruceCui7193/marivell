import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface SearchHighlightState {
  matches: Array<{ from: number; to: number }>;
  currentIndex: number;
  query: string;
}

interface PluginState {
  search: SearchHighlightState;
  version: number;
}

function getDefaultSearchState(): SearchHighlightState {
  return { matches: [], currentIndex: 0, query: '' };
}

function buildDecorations(search: SearchHighlightState): DecorationSet {
  if (search.matches.length === 0) {
    return DecorationSet.empty;
  }

  const decorations: Decoration[] = search.matches.map((match, index) => {
    const isCurrent = index === search.currentIndex;
    return Decoration.inline(match.from, match.to, {
      class: isCurrent ? 'search-highlight-current' : 'search-highlight',
    });
  });

  return DecorationSet.create(decorations[0]!.from, decorations);
}

const searchHighlightKey = new PluginKey<PluginState>('searchHighlight');

export const SearchHighlight = Extension.create({
  name: 'searchHighlight',

  addCommands() {
    return {
      updateSearchHighlights:
        (attrs: { matches: Array<{ from: number; to: number }>; currentIndex: number; query: string }) =>
        ({ editor }) => {
          const search: SearchHighlightState = {
            matches: attrs.matches,
            currentIndex: attrs.currentIndex,
            query: attrs.query,
          };
          const prev = searchHighlightKey.getState(editor.state);
          editor.view.dispatch(
            editor.state.tr.setMeta(searchHighlightKey, {
              search,
              version: (prev?.version ?? 0) + 1,
            } satisfies PluginState),
          );
          return true;
        },

      clearSearchHighlights:
        () =>
        ({ editor }) => {
          const prev = searchHighlightKey.getState(editor.state);
          editor.view.dispatch(
            editor.state.tr.setMeta(searchHighlightKey, {
              search: getDefaultSearchState(),
              version: (prev?.version ?? 0) + 1,
            } satisfies PluginState),
          );
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<PluginState>({
        key: searchHighlightKey,

        state: {
          init(): PluginState {
            return { search: getDefaultSearchState(), version: 0 };
          },
          apply(tr, prev): PluginState {
            const meta = tr.getMeta(searchHighlightKey) as PluginState | undefined;
            if (meta) {
              return meta;
            }
            return prev;
          },
        },

        props: {
          decorations(state) {
            const pluginState = searchHighlightKey.getState(state);
            if (!pluginState) {
              return DecorationSet.empty;
            }
            return buildDecorations(pluginState.search);
          },
        },
      }),
    ];
  },
});
