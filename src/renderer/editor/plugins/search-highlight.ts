import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

export interface SearchHighlightState {
  matches: Array<{ from: number; to: number; isNode?: boolean }>;
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

function buildDecorations(doc: ProseMirrorNode, search: SearchHighlightState): DecorationSet {
  if (search.matches.length === 0) {
    return DecorationSet.empty;
  }

  const decorations: Decoration[] = [];
  search.matches.forEach((match, index) => {
    const isCurrent = index === search.currentIndex;
    const attrs = {
      class: isCurrent ? 'search-highlight-current' : 'search-highlight',
    };
    if (match.isNode) {
      decorations.push(Decoration.node(match.from, match.to, attrs));
    } else {
      decorations.push(Decoration.inline(match.from, match.to, attrs));
    }
  });

  return DecorationSet.create(doc, decorations);
}

export const searchHighlightKey = new PluginKey<PluginState>('searchHighlight');

/**
 * Directly update search highlight decorations. Call this from outside
 * the editor (e.g. from React components) with the editor's view.
 */
export function setSearchHighlights(
  view: EditorView,
  state: SearchHighlightState,
): void {
  const prev = searchHighlightKey.getState(view.state);
  view.dispatch(
    view.state.tr.setMeta(searchHighlightKey, {
      search: state,
      version: (prev?.version ?? 0) + 1,
    } satisfies PluginState),
  );
}

export function clearSearchHighlights(view: EditorView): void {
  const prev = searchHighlightKey.getState(view.state);
  view.dispatch(
    view.state.tr.setMeta(searchHighlightKey, {
      search: getDefaultSearchState(),
      version: (prev?.version ?? 0) + 1,
    } satisfies PluginState),
  );
}

export const SearchHighlight = Extension.create({
  name: 'searchHighlight',

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
            return buildDecorations(state.doc, pluginState.search);
          },
        },
      }),
    ];
  },
});
