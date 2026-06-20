import { createLowlight } from 'lowlight';
import type { AnyExtension } from '@tiptap/core';
import Link from '@tiptap/extension-link';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import Underline from '@tiptap/extension-underline';
import StarterKit from '@tiptap/starter-kit';
import { CodeBlock } from './extensions/code-block';
import { EditableImage } from './extensions/editable-image';
import { FootnoteDefinition } from './extensions/footnote-definition';
import { FootnoteReference } from './extensions/footnote-reference';
import { HtmlBlock } from './extensions/html-block';
import { MermaidBlock } from './extensions/mermaid-block';
import { TypingShortcuts } from './extensions/typing-shortcuts';
import { MathInline } from './extensions/math-inline';
import { TextSelection } from '@tiptap/pm/state';

import { createImageDropPasteExtension } from './plugins/image-drop-paste';
import { createMarkdownPasteExtension } from './plugins/markdown-paste';
import { SearchHighlight } from './plugins/search-highlight';
import { MathSyntaxHighlight } from './plugins/math-syntax-highlight';
import { MathFocusDecoration } from './plugins/math-selection';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const lowlight = createLowlight();

lowlight.register({
  bash,
  cpp,
  csharp,
  css,
  go,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  plaintext,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
});

lowlight.registerAlias({
  bash: ['sh', 'shell', 'zsh'],
  cpp: ['cc', 'cxx', 'h', 'hpp'],
  csharp: ['cs', 'c#'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  markdown: ['md'],
  plaintext: ['text', 'txt'],
  typescript: ['ts', 'tsx'],
  xml: ['html', 'xhtml', 'svg'],
  yaml: ['yml'],
});

interface CreateEditorExtensionsOptions {
  onUploadImage: (file: File) => Promise<string>;
  onResolveImageSource: (src: string) => string;
}

export function createEditorExtensions({
  onUploadImage,
  onResolveImageSource,
}: CreateEditorExtensionsOptions): AnyExtension[] {
  return [
    StarterKit.configure({
      codeBlock: false,
      gapcursor: false,
      heading: {
        levels: [1, 2, 3, 4, 5, 6],
      },
    }),
    Underline,
    Link.configure({
      autolink: true,
      linkOnPaste: true,
      openOnClick: false,
      HTMLAttributes: {
        rel: 'noopener noreferrer nofollow',
        target: '_blank',
      },
    }),
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    Table.configure({
      resizable: true,
      allowTableNodeSelection: true,
      lastColumnResizable: true,
    }),
    TableRow,
    TableHeader,
    TableCell,
    EditableImage.configure({
      inline: false,
      allowBase64: true,
      resolveImageSource: onResolveImageSource,
    }),
    CodeBlock.configure({
      lowlight,
    }),
    MathInline.configure({
      evaluation: false,
    }),
    MermaidBlock,
    HtmlBlock,
    TypingShortcuts,
    FootnoteReference,
    FootnoteDefinition,
    createMarkdownPasteExtension(),
    createImageDropPasteExtension(onUploadImage),
    SearchHighlight,
    MathSyntaxHighlight,
    MathFocusDecoration,
  ];
}
