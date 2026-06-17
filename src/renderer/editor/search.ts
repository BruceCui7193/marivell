import type { Editor } from '@tiptap/react';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';

export interface SearchOptions {
  caseSensitive?: boolean;
}

export interface SourceSearchMatch {
  start: number;
  end: number;
}

export interface VisualTextSearchMatch {
  kind: 'text';
  anchor: number;
  start: number;
  end: number;
  from: number;
  to: number;
}

export interface VisualMathSearchMatch {
  kind: 'math';
  anchor: number;
  start: number;
  end: number;
  pos: number;
  nodeSize: number;
  nodeType: 'mathInline' | 'mathBlock';
}

export type VisualSearchMatch = VisualTextSearchMatch | VisualMathSearchMatch;

function normalizeValue(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLocaleLowerCase();
}

function collectOffsets(text: string, query: string, caseSensitive: boolean): SourceSearchMatch[] {
  if (!query) {
    return [];
  }

  const haystack = normalizeValue(text, caseSensitive);
  const needle = normalizeValue(query, caseSensitive);
  const matches: SourceSearchMatch[] = [];
  let cursor = 0;

  while (cursor <= haystack.length - needle.length) {
    const start = haystack.indexOf(needle, cursor);
    if (start === -1) {
      break;
    }

    matches.push({
      start,
      end: start + needle.length,
    });
    cursor = start + Math.max(needle.length, 1);
  }

  return matches;
}

export function findSourceSearchMatches(
  markdown: string,
  query: string,
  options: SearchOptions = {},
): SourceSearchMatch[] {
  return collectOffsets(markdown, query, Boolean(options.caseSensitive));
}

export function replaceSourceSearchMatch(
  markdown: string,
  match: SourceSearchMatch,
  replacement: string,
): { markdown: string; selection: SourceSearchMatch } {
  const nextMarkdown = `${markdown.slice(0, match.start)}${replacement}${markdown.slice(match.end)}`;
  const selection = {
    start: match.start,
    end: match.start + replacement.length,
  };

  return {
    markdown: nextMarkdown,
    selection,
  };
}

export function replaceAllSourceSearchMatches(
  markdown: string,
  query: string,
  replacement: string,
  options: SearchOptions = {},
): { markdown: string; count: number; firstSelection: SourceSearchMatch | null } {
  const matches = findSourceSearchMatches(markdown, query, options);
  if (!matches.length) {
    return {
      markdown,
      count: 0,
      firstSelection: null,
    };
  }

  let nextMarkdown = markdown;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    nextMarkdown = `${nextMarkdown.slice(0, match.start)}${replacement}${nextMarkdown.slice(match.end)}`;
  }

  return {
    markdown: nextMarkdown,
    count: matches.length,
    firstSelection: {
      start: matches[0].start,
      end: matches[0].start + replacement.length,
    },
  };
}

export function findVisualSearchMatches(
  editor: Editor,
  query: string,
  options: SearchOptions = {},
): VisualSearchMatch[] {
  if (!query) {
    return [];
  }

  const caseSensitive = Boolean(options.caseSensitive);
  const matches: VisualSearchMatch[] = [];

  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      for (const match of collectOffsets(node.text, query, caseSensitive)) {
        matches.push({
          kind: 'text',
          anchor: pos + match.start,
          start: match.start,
          end: match.end,
          from: pos + match.start,
          to: pos + match.end,
        });
      }

      return true;
    }

    if (node.type.name === 'mathInline' || node.type.name === 'mathBlock') {
      const value = String(node.attrs.value ?? '');
      for (const match of collectOffsets(value, query, caseSensitive)) {
        matches.push({
          kind: 'math',
          anchor: pos,
          start: match.start,
          end: match.end,
          pos,
          nodeSize: node.nodeSize,
          nodeType: node.type.name,
        });
      }

      return false;
    }

    return true;
  });

  return matches;
}

export function selectVisualSearchMatch(
  editor: Editor,
  match: VisualSearchMatch,
  focusEditor = true,
): void {
  const { state, view } = editor;

  if (match.kind === 'text') {
    const selection = TextSelection.create(state.doc, match.from, match.to);
    view.dispatch(state.tr.setSelection(selection).scrollIntoView());
    if (focusEditor) {
      view.focus();
    }
    return;
  }

  const selection = NodeSelection.create(state.doc, match.pos);
  view.dispatch(state.tr.setSelection(selection).scrollIntoView());
  if (focusEditor) {
    view.focus();
  }
}

export function replaceVisualSearchMatch(
  editor: Editor,
  match: VisualSearchMatch,
  replacement: string,
): boolean {
  const { state, view } = editor;
  let tr = state.tr;

  if (match.kind === 'text') {
    tr = tr.insertText(replacement, match.from, match.to);
    tr = tr.setSelection(
      TextSelection.create(tr.doc, match.from, match.from + replacement.length),
    );
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return true;
  }

  const node = tr.doc.nodeAt(match.pos);
  if (!node) {
    return false;
  }

  const value = String(node.attrs.value ?? '');
  const nextValue = `${value.slice(0, match.start)}${replacement}${value.slice(match.end)}`;
  tr = tr.setNodeMarkup(match.pos, undefined, {
    ...node.attrs,
    value: nextValue,
  });
  tr = tr.setSelection(NodeSelection.create(tr.doc, match.pos));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

export function replaceAllVisualSearchMatches(
  editor: Editor,
  query: string,
  replacement: string,
  options: SearchOptions = {},
): number {
  const matches = findVisualSearchMatches(editor, query, options);
  if (!matches.length) {
    return 0;
  }

  const mathGroups = new Map<number, VisualMathSearchMatch[]>();
  const operations: Array<
    | { type: 'text'; anchor: number; match: VisualTextSearchMatch }
    | { type: 'math'; anchor: number; pos: number }
  > = [];

  for (const match of matches) {
    if (match.kind === 'text') {
      operations.push({
        type: 'text',
        anchor: match.anchor,
        match,
      });
      continue;
    }

    if (!mathGroups.has(match.pos)) {
      mathGroups.set(match.pos, []);
      operations.push({
        type: 'math',
        anchor: match.anchor,
        pos: match.pos,
      });
    }

    mathGroups.get(match.pos)?.push(match);
  }

  operations.sort((left, right) => right.anchor - left.anchor);

  let tr = editor.state.tr;
  for (const operation of operations) {
    if (operation.type === 'text') {
      tr = tr.insertText(replacement, operation.match.from, operation.match.to);
      continue;
    }

    const node = tr.doc.nodeAt(operation.pos);
    if (!node) {
      continue;
    }

    const group = mathGroups.get(operation.pos);
    if (!group?.length) {
      continue;
    }

    let nextValue = String(node.attrs.value ?? '');
    const orderedGroup = [...group].sort((left, right) => right.start - left.start);
    for (const match of orderedGroup) {
      nextValue = `${nextValue.slice(0, match.start)}${replacement}${nextValue.slice(match.end)}`;
    }

    tr = tr.setNodeMarkup(operation.pos, undefined, {
      ...node.attrs,
      value: nextValue,
    });
  }

  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return matches.length;
}
