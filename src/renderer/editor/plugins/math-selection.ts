import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, NodeSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const mathFocusKey = new PluginKey<number | null>('mathFocus');

export const MathFocusDecoration = Extension.create({
  name: 'mathFocusDecoration',

  addProseMirrorPlugins() {
    return [
      new Plugin<number | null>({
        key: mathFocusKey,
        state: {
          init(): number | null {
            return null;
          },
          apply(tr, old: number | null, _oldState, newState): number | null {
            if (!tr.selectionSet && !tr.docChanged) return old;

            const { selection } = newState;

            if (selection instanceof NodeSelection) {
              if (selection.node.type.name === 'inlineMath') {
                return selection.from;
              }
              return null;
            }

            if (selection.empty) {
              const { $from } = selection;
              if ($from.parent.type.name === 'inlineMath') {
                return $from.before($from.depth);
              }
            } else {
              // Non-empty selection: keep editing if the whole selection
              // stays inside a single inlineMath node (e.g. selecting text
              // inside the formula). Leaving the formula should drop focus.
              const { $from, $to } = selection;
              if (
                $from.parent === $to.parent &&
                $from.parent.type.name === 'inlineMath'
              ) {
                return $from.before($from.depth);
              }
            }

            return null;
          },
        },

        props: {
          decorations(state) {
            const pos = mathFocusKey.getState(state);
            if (pos == null) return DecorationSet.empty;

            const node = state.doc.nodeAt(pos);
            if (!node || node.type.name !== 'inlineMath') {
              return DecorationSet.empty;
            }

            try {
              if (localStorage.getItem('__mathDebug') === '1') {
                console.log('[math] focus deco at', pos);
              }
            } catch {}

            return DecorationSet.create(state.doc, [
              Decoration.node(pos, pos + node.nodeSize, { class: 'is-editing' }),
            ]);
          },
        },
      }),
    ];
  },
});
