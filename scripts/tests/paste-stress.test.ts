import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="editor"></div></body></html>');
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.File = dom.window.File;
g.FileList = dom.window.FileList;
g.ClipboardEvent = dom.window.ClipboardEvent;
g.CustomEvent = dom.window.CustomEvent;
g.DragEvent = dom.window.DragEvent;
g.MutationObserver = dom.window.MutationObserver;
g.DOMParser = dom.window.DOMParser;
g.Node = dom.window.Node;
g.Element = dom.window.Element;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLCanvasElement = dom.window.HTMLCanvasElement;

import { Editor } from '@tiptap/core';
import { createEditorExtensions } from '../../src/renderer/editor/create-editor-extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/renderer/editor/markdown';
import { buildClipboardPayload } from '../../src/renderer/editor/clipboard';
import { pasteClipboardPayload, type ClipboardPastePayload } from '../../src/renderer/editor/plugins/markdown-paste';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function makeEditor(content = ''): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: createEditorExtensions({
      onUploadImage: async () => ({ src: 'x.png', absolutePath: 'x.png' }),
      onResolveImageSource: (src) => src,
    }),
    content: parseMarkdown(content),
  });
}

function md(editor: Editor): string {
  return serializeMarkdown(editor.getJSON());
}

function paste(editor: Editor, payload: Partial<ClipboardPastePayload>): void {
  const normalized: ClipboardPastePayload = {
    text: payload.text ?? '',
    html: payload.html ?? '',
    markdown: payload.markdown ?? '',
    files: payload.files,
  };
  const handled = pasteClipboardPayload(editor, normalized);

  // ProseMirror's default clipboard insertion runs only when the custom
  // handler declines. Simulate that fallback so unstructured text behaves as
  // it does in a real paste event instead of silently remaining untested.
  if (!handled && normalized.text && !normalized.html && !normalized.markdown) {
    editor.view.pasteText(normalized.text, {
      clipboardData: {
        getData: (type: string) => (type === 'text/plain' ? normalized.text : ''),
      },
    } as unknown as ClipboardEvent);
  }
}

function countNodes(editor: Editor, typeName: string): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === typeName) count += 1;
    return true;
  });
  return count;
}

function findNodeAttrs(editor: Editor, typeName: string): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === typeName) result.push(node.attrs as Record<string, unknown>);
    return true;
  });
  return result;
}

function expectAll(source: string, required: string[], name: string): boolean {
  const missing = required.filter((item) => !source.includes(item));
  assert(`${name} keeps every fragment`, missing.length === 0, `missing=${JSON.stringify(missing)}; source=${JSON.stringify(source)}`);
  return missing.length === 0;
}

function seededRandom(seed: number): () => number {
  let state = seed % 2_147_483_647;
  if (state <= 0) state += 2_147_483_646;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
}

console.log('\n## external HTML mixed-table regression');

{
  const html = [
    '<h2>模型细节</h2>',
    '<p>下面是 <strong>模型</strong> 的能力概览。</p>',
    '<table><thead><tr><th>模型</th><th>上下文</th><th>价格</th></tr></thead>',
    '<tbody><tr><td><a href="https://example.com/chat">deepseek-chat</a></td><td>64K</td><td><code>low</code></td></tr>',
    '<tr><td>deepseek-reasoner</td><td>64K</td><td>medium</td></tr></tbody></table>',
    '<p>(3) 更多并发限制细节，请参考<a href="https://example.com/limits">限速与隔离</a>。</p>',
  ].join('');
  const text = '模型细节\n\n下面是 模型 的能力概览。\n\n模型\t上下文\t价格\ndeepseek-chat\t64K\tlow\n\n(3) 更多并发限制细节，请参考限速与隔离。';
  const editor = makeEditor();
  try {
    paste(editor, { text, html });
    const source = md(editor);
    expectAll(source, ['模型细节', '**模型**', '| 模型 |', 'deepseek-chat', 'deepseek-reasoner', '(3) 更多并发限制细节'], 'DeepSeek pricing selection');
    assert('mixed web selection keeps table structure', countNodes(editor, 'table') === 1, source);
  } finally {
    editor.destroy();
  }
}

console.log('\n## table boundary matrix');

const tableHtml = '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>D</td></tr></tbody></table>';
const boundaries = [
  ['heading', '<h2>HEAD-248</h2>', 'HEAD-248'],
  ['paragraph', '<p>PARA-519</p>', 'PARA-519'],
  ['bullet list', '<ul><li>LIST-733</li></ul>', '- LIST-733'],
  ['ordered list', '<ol><li>ORDER-164</li></ol>', '1. ORDER-164'],
  ['blockquote', '<blockquote>QUOTE-915</blockquote>', '> QUOTE-915'],
  ['code block', '<pre><code class="language-js">CODE-372</code></pre>', '```js\nCODE-372\n```'],
];

for (const before of [false, true]) {
  for (const after of [false, true]) {
    for (const [label, tag, expected] of boundaries) {
      const name = `${before ? label : 'no'} before + ${after ? label : 'no'} after`;
      const editor = makeEditor();
      try {
        paste(editor, {
          text: [before ? tag.replace(/<[^>]+>/g, '').replace(/^(\d+\.)\s/, '$1 ') : '', 'H D', after ? tag.replace(/<[^>]+>/g, '').replace(/^(\d+\.)\s/, '$1 ') : ''].filter(Boolean).join('\n'),
          html: `${before ? tag : ''}${tableHtml}${after ? tag : ''}`,
        });
        const source = md(editor);
        const required = [
          ...(before ? [expected] : []),
          '| H |',
          '| D |',
          ...(after ? [expected] : []),
        ];
        expectAll(source, required, `table ${name}`);
      } finally {
        editor.destroy();
      }
    }
  }
}

console.log('\n## common web clipping matrix');

const webCases: Array<{ name: string; html: string; required: string[]; node?: [string, number] }> = [
  {
    name: 'article headings and emphasis',
    html: '<article><h1>TITLE-101</h1><section><p>A <b>BOLD-202</b> and <i>ITALY-303</i>.</p><p aria-level="2" role="heading" class="text-xl font-semibold">PRESENTED-404</p></section></article>',
    required: ['# TITLE-101', '**BOLD-202**', '*ITALY-303*', '# PRESENTED-404'],
  },
  {
    name: 'nested lists',
    html: '<ul><li>PARENT-505<ol><li>CHILD-606<ul><li>LEAF-707</li></ul></li></ol></li></ul>',
    required: ['- PARENT-505', '1. CHILD-606', '- LEAF-707'],
  },
  {
    name: 'definition-like blocks',
    html: '<dl><dt>TERM-808</dt><dd>MEANING-909</dd></dl><p>AFTER-010</p>',
    required: ['TERM-808', 'MEANING-909', 'AFTER-010'],
  },
  {
    name: 'quote with inline code',
    html: '<blockquote><p>SAY-111 <code>VALUE-222</code></p></blockquote>',
    required: ['> SAY-111', '`VALUE-222`'],
  },
  {
    name: 'code and horizontal rule',
    html: '<pre><code class="language-python">print("PY-333")</code></pre><hr><p>NEXT-444</p>',
    required: ['```python', 'print("PY-333")', '---', 'NEXT-444'],
  },
  {
    name: 'links and image',
    html: '<p><a href="https://example.com/a">LINK-555</a></p><img src="https://example.com/i.png" alt="ALT-666">',
    required: ['[LINK-555](https://example.com/a)', '![ALT-666](https://example.com/i.png)'],
  },
  {
    name: 'KaTeX inline and display math',
    html: '<p>Euler is <span class="katex" data-tex="e^{i\\pi}">ignored</span>.</p><div class="katex-display"><span data-tex="\\sum x">ignored</span></div><p>MATH-DONE</p>',
    required: ['$e^{i\\pi}$', '$$\n\\sum x\n$$', 'MATH-DONE'],
  },
  {
    name: 'wrapped pure table',
    html: '<div class="scroll-x"><table><tr><th>A</th></tr><tr><td>B</td></tr></table></div>',
    required: ['| A |', '| B |'],
    node: ['table', 1],
  },
  {
    name: 'two tables with text between them',
    html: `<table><tr><th>T1</th></tr><tr><td>V1</td></tr></table><p>BETWEEN-777</p><table><tr><th>T2</th></tr><tr><td>V2</td></tr></table>`,
    required: ['| T1 |', '| V1 |', 'BETWEEN-777', '| T2 |', '| V2 |'],
    node: ['table', 2],
  },
  {
    name: 'entities and CJK punctuation',
    html: '<p>&lt;TAG&gt; “中文” &amp; CO-888</p>',
    required: ['<TAG> “中文” & CO-888'],
  },
  {
    name: 'empty paragraphs and comments do not lose text',
    html: '<!-- comment --><p></p><p>SPARSE-999</p><p></p>',
    required: ['SPARSE-999'],
  },
];

for (const item of webCases) {
  const editor = makeEditor();
  try {
    paste(editor, { text: item.required.join(' '), html: item.html });
    const source = md(editor);
    expectAll(source, item.required, `web ${item.name}`);
    if (item.node) assert(`web ${item.name} keeps ${item.node[0]} count`, countNodes(editor, item.node[0]) === item.node[1], source);
  } finally {
    editor.destroy();
  }
}

console.log('\n## deeply nested web clipping matrix');

const nestedWebCases: Array<{ name: string; html: string; required: string[]; node?: [string, number] }> = [
  {
    name: 'blockquote contains ordered, bullet, marks and code',
    html: '<blockquote><ol><li>NESTED-FIRST<ul><li>NESTED-SECOND<strong>NESTED-BOLD</strong></li></ul></li><li><code>NESTED-CODE</code></li></ol></blockquote>',
    required: ['> 1. NESTED-FIRST', '- NESTED-SECOND', '**NESTED-BOLD**', '`NESTED-CODE`'],
  },
  {
    name: 'details preserves summary, paragraph, list, code and table',
    html: '<details><summary>DETAILS-SUMMARY</summary><p>DETAILS-PARAGRAPH</p><ul><li>DETAILS-LIST</li></ul><pre><code class="language-js">DETAILS-JS</code></pre><table><tr><th>DETAILS-TH</th></tr><tr><td>DETAILS-TD</td></tr></table></details>',
    required: ['**DETAILS-SUMMARY**', 'DETAILS-PARAGRAPH', '- DETAILS-LIST', '```js', 'DETAILS-JS', '| DETAILS-TH |', '| DETAILS-TD |'],
    node: ['table', 1],
  },
  {
    name: 'ordered list item contains quote, code and table',
    html: '<ol><li>COMPOSITE-LIST<blockquote><p>COMPOSITE-QUOTE</p></blockquote><pre><code class="js">COMPOSITE-CODE</code></pre><table><tr><th>COMPOSITE-TH</th></tr><tr><td>COMPOSITE-TD</td></tr></table></li></ol>',
    required: ['1. COMPOSITE-LIST', '> COMPOSITE-QUOTE', 'COMPOSITE-CODE', '| COMPOSITE-TH |', '| COMPOSITE-TD |'],
    node: ['table', 1],
  },
  {
    name: 'definition list preserves terms and definitions',
    html: '<dl><dt>TERM-ALPHA</dt><dd>DEFINITION-ALPHA</dd><dt>TERM-BETA</dt><dd>DEFINITION-BETA</dd></dl>',
    required: ['**TERM-ALPHA**', 'DEFINITION-ALPHA', '**TERM-BETA**', 'DEFINITION-BETA'],
  },
];

for (const item of nestedWebCases) {
  const editor = makeEditor();
  try {
    paste(editor, { text: item.required.join(' '), html: item.html });
    const source = md(editor);
    expectAll(source, item.required, `nested web ${item.name}`);
    if (item.node) assert(`nested web ${item.name} keeps ${item.node[0]} count`, countNodes(editor, item.node[0]) === item.node[1], source);
    assert(`nested web ${item.name} is marker-free`, !source.includes('MDEDITORSELECTION'), source);
  } finally {
    editor.destroy();
  }
}

const nestedPlainCases: Array<{ name: string; input: string; required: string[]; node?: [string, number] }> = [
  {
    name: 'three-level bullet/task mix',
    input: '- PLAIN-PARENT\n  - [ ] PLAIN-TASK\n    - PLAIN-GRAND\n- [x] PLAIN-DONE\n',
    required: ['- PLAIN-PARENT', '- [ ] PLAIN-TASK', '- PLAIN-GRAND', '- [x] PLAIN-DONE'],
  },
  {
    name: 'quote contains math and list',
    input: '> BEFORE-MATH\n>\n> $$\n> NESTED_X^2\n> $$\n>\n> - QUOTE-LIST\n',
    required: ['> BEFORE-MATH', '> $$', '> NESTED_X^2', '- QUOTE-LIST'],
    node: ['inlineMath', 1],
  },
  {
    name: 'list contains code and image',
    input: '- LIST-WITH-CODE\n  ```js\n  LIST_JS\n  ```\n- ![LIST-IMG](./list.png)\n',
    required: ['- LIST-WITH-CODE', '```js', 'LIST_JS', '![LIST-IMG](./list.png)'],
    node: ['image', 1],
  },
  {
    name: 'math in quote in list',
    input: '- > $$\n  > DEEP_FORMULA\n  > $$\n',
    required: ['DEEP_FORMULA'],
  },
];

for (const item of nestedPlainCases) {
  const editor = makeEditor();
  try {
    paste(editor, { text: item.input });
    const source = md(editor);
    expectAll(source, item.required, `nested plain ${item.name}`);
    if (item.node) assert(`nested plain ${item.name} keeps ${item.node[0]} count`, countNodes(editor, item.node[0]) === item.node[1], source);
  } finally {
    editor.destroy();
  }
}

console.log('\n## adversarial HTML clipping matrix');

const adversarialHtmlCases: Array<{
  name: string;
  html: string;
  required?: string[];
  forbidden?: string[];
  nodes?: Array<[string, number]>;
}> = [
  {
    name: 'table caption and cell line break',
    html: '<table><caption>CAPTION-TOKEN</caption><tr><th>H</th></tr><tr><td>A<br>B</td></tr></table>',
    required: ['CAPTION-TOKEN', '| H |', 'A B'],
    nodes: [['table', 1]],
  },
  {
    name: 'adjacent wrapped tables both remain',
    html: '<div><table><tr><th>T-A</th></tr><tr><td>V-A</td></tr></table><table><tr><th>T-B</th></tr><tr><td>V-B</td></tr></table></div>',
    required: ['T-A', 'V-A', 'T-B', 'V-B'],
    nodes: [['table', 2]],
  },
  {
    name: 'HTML ordered start and checkboxes',
    html: '<ol start="3"><li><input type="checkbox" checked>ORDER-TASK-DONE</li><li>ORDER-NORMAL</li><li><input type="checkbox">ORDER-TASK-OPEN</li></ol>',
    required: ['[x] ORDER-TASK-DONE', 'ORDER-NORMAL', '[ ] ORDER-TASK-OPEN'],
  },
  {
    name: 'script and style content never leak',
    html: '<style>.STYLE-TOKEN{color:red}</style><p>VISIBLE-TOKEN</p><script>var SCRIPT_TOKEN = 1;</script>',
    required: ['VISIBLE-TOKEN'],
    forbidden: ['STYLE-TOKEN', 'SCRIPT_TOKEN'],
  },
  {
    name: 'three-level quote remains quoted',
    html: '<blockquote><blockquote><blockquote><p>DEEP-QUOTE</p></blockquote></blockquote></blockquote>',
    required: ['> > > DEEP-QUOTE'],
  },
  {
    name: 'nested details remain hierarchical in Markdown output',
    html: '<details><summary>OUTER-SUMMARY</summary><p>OUTER-PARAGRAPH<details><summary>INNER-SUMMARY</summary><p>INNER-PARAGRAPH</p></details></p></details>',
    required: ['OUTER-SUMMARY', 'OUTER-PARAGRAPH', 'INNER-SUMMARY', 'INNER-PARAGRAPH'],
  },
  {
    name: 'figure caption and presentation heading',
    html: '<figure><img src="./figure.png" alt="FIGURE-ALT"><figcaption>FIGURE-CAPTION</figcaption></figure><div role="heading" aria-level="3" class="text-xl font-semibold">PRESENTATION-H3</div>',
    required: ['![FIGURE-ALT](./figure.png)', 'FIGURE-CAPTION', '### PRESENTATION-H3'],
    nodes: [['image', 1]],
  },
  {
    name: 'nested table content is flattened without duplication',
    html: '<table><tr><th>OUTER-H</th></tr><tr><td>OUTER-CELL<table><tr><th>INNER-H</th></tr><tr><td>INNER-CELL</td></tr></table></td></tr></table>',
    required: ['OUTER-H', 'OUTER-CELL', 'INNER-H', 'INNER-CELL'],
    forbidden: ['OUTER-CELLINNER-H', '| OUTER-H | | INNER-H |'],
    nodes: [['table', 1]],
  },
];

for (const item of adversarialHtmlCases) {
  const editor = makeEditor();
  try {
    paste(editor, { text: (item.required ?? []).join(' '), html: item.html });
    const source = md(editor);
    if (item.required) expectAll(source, item.required, `adversarial HTML ${item.name}`);
    for (const token of item.forbidden ?? []) {
      assert(`adversarial HTML ${item.name} omits ${token}`, !source.includes(token), source);
    }
    for (const [type, expectedCount] of item.nodes ?? []) {
      assert(`adversarial HTML ${item.name} keeps ${type} count`, countNodes(editor, type) === expectedCount, source);
    }
    assert(`adversarial HTML ${item.name} is marker-free`, !source.includes('MDEDITORSELECTION'), source);
  } finally {
    editor.destroy();
  }
}

console.log('\n## deep nesting wrapper matrix');

const nestingPayloads = [
  {
    kind: 'paragraph',
    make: (token: string) => `A ${token} **bold-${token}** \`code-${token}\``,
    tokens: (token: string) => [`A ${token}`, `bold-${token}`, `code-${token}`],
  },
  {
    kind: 'display math',
    make: (token: string) => `$$${token}^2$$`,
    tokens: (token: string) => [token],
  },
  {
    kind: 'nested list',
    make: (token: string) => `- OUTER-${token}\n  - INNER-${token}`,
    tokens: (token: string) => [`OUTER-${token}`, `INNER-${token}`],
  },
  {
    kind: 'fence',
    make: (token: string) => `\`\`\`js\nconst value = '${token}';\n\`\`\``,
    tokens: (token: string) => [token],
  },
  {
    kind: 'table',
    make: (token: string) => `| ${token}-H | VALUE |\n| --- | --- |\n| ${token}-D | X |`,
    tokens: (token: string) => [`${token}-H`, `${token}-D`],
  },
];

function prefixLines(value: string, prefix: string, firstPrefix = prefix): string {
  return value.split('\n').map((line, index) => `${index === 0 ? firstPrefix : prefix}${line}`).join('\n');
}

function indentBody(value: string, width = 2): string {
  const pad = ' '.repeat(width);
  return value.split('\n').map((line, index) => (index === 0 ? line : `${pad}${line}`)).join('\n');
}

const nestingWrappers: Array<{ name: string; wrap: (value: string) => string }> = [
  { name: 'plain', wrap: (value) => value },
  { name: 'quote', wrap: (value) => prefixLines(value, '> ') },
  { name: 'double quote', wrap: (value) => prefixLines(prefixLines(value, '> '), '> ') },
  { name: 'bullet', wrap: (value) => indentBody(`- ${value}`) },
  { name: 'ordered', wrap: (value) => indentBody(`7. ${value}`, 3) },
  { name: 'open task', wrap: (value) => indentBody(`- [ ] ${value}`) },
  { name: 'done task', wrap: (value) => indentBody(`- [x] ${value}`) },
  { name: 'quoted bullet', wrap: (value) => prefixLines(indentBody(`- ${value}`), '> ') },
];

for (const payload of nestingPayloads) {
  for (const wrapper of nestingWrappers) {
    const token = `${payload.kind.replace(/[^a-z]+/gi, '')}-NEST`;
    const input = wrapper.wrap(payload.make(token));
    const editor = makeEditor();
    try {
      paste(editor, { text: input });
      const source = md(editor);
      expectAll(source, payload.tokens(token), `${wrapper.name}/${payload.kind} nesting`);
      assert(`${wrapper.name}/${payload.kind} nesting is non-empty`, source.trim().length > 0, JSON.stringify({ input, source }));
      assert(`${wrapper.name}/${payload.kind} nesting is marker-free`, !source.includes('MDEDITORSELECTION'), source);
      const structuralNode = payload.kind === 'fence'
        ? 'codeBlock'
        : payload.kind === 'table'
          ? 'table'
          : payload.kind === 'display math'
            ? 'inlineMath'
            : null;
      if (structuralNode) {
        assert(
          `${wrapper.name}/${payload.kind} nesting keeps node`,
          countNodes(editor, structuralNode) === 1,
          JSON.stringify({ input, source }),
        );
      }
    } finally {
      editor.destroy();
    }
  }
}

console.log('\n## generated deep plain containers');

type DeepPayload = {
  kind: string;
  make: (token: string) => string;
  tokens: (token: string) => string[];
  node?: string;
};

const deepPlainPayloads: DeepPayload[] = [
  {
    kind: 'code',
    make: (token) => `\`\`\`js\nconst deep = '${token}';\n\`\`\``,
    tokens: (token) => [token],
    node: 'codeBlock',
  },
  {
    kind: 'math',
    make: (token) => `$$${token} + 1$$`,
    tokens: (token) => [token],
    node: 'inlineMath',
  },
  {
    kind: 'table',
    make: (token) => `| ${token}-H | NEXT |\n| --- | --- |\n| ${token}-B | Y |`,
    tokens: (token) => [`${token}-H`, `${token}-B`],
    node: 'table',
  },
  {
    kind: 'tree',
    make: (token) => `- ${token}-P\n  - [ ] ${token}-T\n    - ${token}-C`,
    tokens: (token) => [`${token}-P`, `${token}-T`, `${token}-C`],
  },
];

const deepPlainWrappers: Array<{ name: string; wrap: (value: string) => string }> = [
  { name: 'quote x3', wrap: (value) => prefixLines(prefixLines(prefixLines(value, '> '), '> '), '> ') },
  { name: 'ordered 12', wrap: (value) => indentBody(`12. ${value}`, 4) },
  {
    name: 'quoted done task',
    wrap: (value) => value.split('\n').map((line, index) => `${index === 0 ? '> - [x] ' : '>       '}${line}`).join('\n'),
  },
  {
    name: 'task in bullet',
    wrap: (value) => value.split('\n').map((line, index) => `${index === 0 ? '- OUTER\n  - [ ] ' : '        '}${line}`).join('\n'),
  },
];

for (const payload of deepPlainPayloads) {
  for (const wrapper of deepPlainWrappers) {
    const token = `${payload.kind.toUpperCase()}_DEEP`;
    const input = wrapper.wrap(payload.make(token));
    const editor = makeEditor();
    try {
      paste(editor, { text: input });
      const source = md(editor);
      expectAll(source, payload.tokens(token), `deep plain ${wrapper.name}/${payload.kind}`);
      assert(`deep plain ${wrapper.name}/${payload.kind} is marker-free`, !source.includes('MDEDITORSELECTION'), source);
      if (payload.node) {
        assert(
          `deep plain ${wrapper.name}/${payload.kind} preserves node`,
          countNodes(editor, payload.node) === 1,
          source,
        );
      }
    } finally {
      editor.destroy();
    }
  }
}

console.log('\n## generated deeply wrapped HTML');

const deepHtmlPayloads: Array<{ kind: string; make: (token: string) => string; tokens: (token: string) => string[]; node?: string }> = [
  {
    kind: 'paragraph',
    make: (token) => `<p>HTML-${token}</p>`,
    tokens: (token) => [`HTML-${token}`],
  },
  {
    kind: 'code',
    make: (token) => `<pre><code class="language-js">HTML_${token}</code></pre>`,
    tokens: (token) => [`HTML_${token}`],
    node: 'codeBlock',
  },
  {
    kind: 'math',
    make: (token) => `<div class="katex-display"><span data-tex="HTML_X_${token}">ignored</span></div>`,
    tokens: (token) => [`HTML_X_${token}`],
    node: 'inlineMath',
  },
  {
    kind: 'table',
    make: (token) => `<table><tr><th>${token}-H</th></tr><tr><td>${token}-B</td></tr></table>`,
    tokens: (token) => [`${token}-H`, `${token}-B`],
    node: 'table',
  },
  {
    kind: 'list tree',
    make: (token) => `<ul><li>${token}-P<ol><li>${token}-C</li></ol></li></ul>`,
    tokens: (token) => [`${token}-P`, `${token}-C`],
  },
];

const deepHtmlWrappers: Array<{ name: string; wrap: (value: string) => string }> = [
  { name: 'semantic shell', wrap: (value) => `<article><section><main><div>${value}</div></main></section></article>` },
  { name: 'blockquote', wrap: (value) => `<blockquote><div>${value}</div></blockquote>` },
  { name: 'bullet item', wrap: (value) => `<ul><li>OUTER-HOST<div>${value}</div></li></ul>` },
  { name: 'details', wrap: (value) => `<details><summary>SUMMARY-HOST</summary><div>${value}</div></details>` },
];

for (const payload of deepHtmlPayloads) {
  for (const wrapper of deepHtmlWrappers) {
    const token = `${payload.kind.replace(/\s+/g, '_').toUpperCase()}_HOST`;
    const html = wrapper.wrap(payload.make(token));
    const editor = makeEditor();
    try {
      paste(editor, { text: payload.tokens(token).join(' '), html });
      const source = md(editor);
      const required = wrapper.name === 'details'
        ? ['SUMMARY-HOST', ...payload.tokens(token)]
        : payload.tokens(token);
      expectAll(source, required, `deep HTML ${wrapper.name}/${payload.kind}`);
      assert(`deep HTML ${wrapper.name}/${payload.kind} is marker-free`, !source.includes('MDEDITORSELECTION'), source);
      if (payload.node) {
        assert(
          `deep HTML ${wrapper.name}/${payload.kind} preserves node`,
          countNodes(editor, payload.node) === 1,
          source,
        );
      }
    } finally {
      editor.destroy();
    }
  }
}

console.log('\n## external plain Markdown stress');

const plainCases: Array<[string, string, string[]]> = [
  ['CRLF multiline', 'FIRST-100\r\n\r\nSECOND-200\r\n', ['FIRST-100', 'SECOND-200']],
  ['display formula then paragraph', '$$x$$\n\nAFTER-300', ['$$\nx\n$$', 'AFTER-300']],
  ['formula inside paragraph', 'BEFORE-400 $a^2+b^2$ AFTER-500', ['$a^2+b^2$', 'BEFORE-400', 'AFTER-500']],
  ['currency does not become math', 'Price $5 and $10', ['Price $5 and $10']],
  ['escaped markdown', '\\# NOT-600 \\*STAR\\*', ['# NOT-600', '*STAR*']],
  ['escaped punctuation and backslash', '\\!BANG\\%PERCENT\\\\SLASH', ['!BANG', '%PERCENT', '\\SLASH']],
  ['nested bullet task mix', '- PARENT-700\n  - CHILD-800\n- [x] DONE-900', ['- PARENT-700', '- CHILD-800', '- [x] DONE-900']],
  ['ordered list restarts', '1. ONE-A\n2. TWO-B\n\n3. THREE-C', ['1. ONE-A', '2. TWO-B', '3. THREE-C']],
  ['table with escaped pipe', '| A | B |\n| --- | --- |\n| `x\\|y` | V |', ['| A | B |', '`x\\|y`']],
  ['fence containing dollar', '```md\n# CODE-$X$\n```', ['```md', '# CODE-$X$', '```']],
  ['footnote', 'TEXT-A[^1]\n\n[^1]: NOTE-B', ['TEXT-A[^1]', '[^1]: NOTE-B']],
  ['hard breaks stay in paragraph', 'LINE-A  \nLINE-B', ['LINE-A', 'LINE-B']],
  ['HTML literal remains content', '<div>LITERAL-X</div>', ['LITERAL-X']],
];

for (const [name, input, required] of plainCases) {
  const editor = makeEditor();
  try {
    paste(editor, { text: input });
    expectAll(md(editor), required, `plain ${name}`);
  } finally {
    editor.destroy();
  }
}

console.log('\n## destination context stress');

const destinations: Array<[string, string]> = [
  ['empty', ''],
  ['paragraph', 'DEST-PARA'],
  ['heading', '# DEST-HEADING'],
  ['quote', '> DEST-QUOTE'],
  ['bullet', '- DEST-BULLET'],
  ['ordered', '1. DEST-ORDERED'],
  ['task', '- [ ] DEST-TASK'],
  ['code', '```js\nDEST-CODE\n```'],
  ['inline math', '$DEST-MATH$'],
  ['table', '| H1 | H2 |\n| --- | --- |\n| DEST-TABLE | X |'],
];

for (const [destination, source] of destinations) {
  for (const round of [1, 2]) {
    const editor = makeEditor(source);
    try {
      const marker = round === 1 ? 'PASTE-ONE' : 'PASTE-TWO';
      paste(editor, { text: `${marker} $m^${round}$`, html: '' });
      const result = md(editor);
      assert(`${destination} destination round ${round} retains marker`, result.includes(marker), result);
      assert(`${destination} destination round ${round} retains latex`, result.includes(`m^${round}`), result);
      assert(`${destination} destination round ${round} has no selection token`, !result.includes('MDEDITORSELECTION'), result);
    } finally {
      editor.destroy();
    }
  }
}

console.log('\n## clipboard MIME priority');

{
  const editor = makeEditor();
  try {
    paste(editor, { text: 'WRONG-PLAIN', html: '<p>WRONG-HTML</p>', markdown: '$$RIGHT-MATH$$' });
    const source = md(editor);
    assert('first-party Markdown beats text and HTML', source.includes('$$\nRIGHT-MATH\n$$') && !source.includes('WRONG'), source);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor();
  try {
    paste(editor, {
      text: 'A\tB\n1\t2',
      html: '<span>not structured</span>',
    });
    const source = md(editor);
    assert('tabular plain text becomes a table', countNodes(editor, 'table') === 1 && source.includes('| A | B |') && source.includes('| 1 | 2 |'), source);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor();
  const file = new File(['image-bytes'], 'clipboard.png', { type: 'image/png' });
  try {
    const handled = pasteClipboardPayload(editor, { text: '', html: '', files: [file] });
    assert('image-only clipboard defers to image extension', handled === false, String(handled));
  } finally {
    editor.destroy();
  }
}

console.log('\n## deterministic cross-provider paste fuzz');

const fuzzBlocks = [
  (i: number) => `# HEAD-${i}`,
  (i: number) => `段落-${i} **bold-${i}** *italic* \`code-${i}\``,
  (i: number) => `- ITEM-${i}\n  - NESTED-${i}`,
  (i: number) => `1. FIRST-${i}\n2. SECOND-${i}`,
  (i: number) => `> QUOTE-${i}`,
  (i: number) => '```ts\nconst value = "FENCE-' + i + '";\n```',
  (i: number) => `| H${i} | VALUE |\n| --- | --- |\n| CELL-${i} | ${i} |`,
  (i: number) => `$FORMULA-${i}^{$i}$`,
  (i: number) => `TEXT-LINK-${i}`,
  (i: number) => `CJK-${i}-内容`,
];

const random = seededRandom(20260823);
for (let iteration = 0; iteration < 80; iteration += 1) {
  const selected: string[] = [];
  const blockCount = 3 + Math.floor(random() * 5);
  let cursor = 0;
  for (let index = 0; index < blockCount; index += 1) {
    cursor = Math.floor(random() * fuzzBlocks.length);
    selected.push(fuzzBlocks[cursor]!(index));
  }
  const input = selected.join('\n\n');
  const editor = makeEditor();
  try {
    paste(editor, { text: input, html: '' });
    const source = md(editor);
    const uniqueTokens = selected.map((block) => {
      const match = block.match(/(?:HEAD|段落|ITEM|NESTED|FIRST|SECOND|QUOTE|FENCE|CELL|FORMULA|TEXT-LINK|CJK)-\d+/);
      return match?.[0] ?? '';
    }).filter(Boolean);
    assert(`fuzz ${iteration + 1} stays non-empty`, source.trim().length > 0, JSON.stringify(input));
    assert(`fuzz ${iteration + 1} has no clipboard token`, !source.includes('MDEDITORSELECTION'), source.slice(0, 500));
    assert(`fuzz ${iteration + 1} retains all unique tokens`, uniqueTokens.every((token) => source.includes(token)), JSON.stringify({ uniqueTokens, source }));
  } finally {
    editor.destroy();
  }
}

console.log('\n## generated internal copy/paste round trips');

const nestedInternalCases: Array<{
  name: string;
  source: string;
  required: string[];
  nodes?: Array<[string, number]>;
}> = [
  {
    name: 'quote with list and code',
    source: '> QUOTE-START\n>\n> - QUOTE-ITEM\n>\n> ```js\n> QUOTE_JS\n> ```\n',
    required: ['QUOTE-START', 'QUOTE-ITEM', 'QUOTE_JS'],
    nodes: [['codeBlock', 1]],
  },
  {
    name: 'quote with display formula',
    source: '> BEFORE-QMATH\n>\n> $$\n> QMATH_X^2\n> $$\n',
    required: ['BEFORE-QMATH', 'QMATH_X^2'],
    nodes: [['inlineMath', 1]],
  },
  {
    name: 'mixed bullet task tree',
    source: '- MIXED-PARENT\n  - [ ] MIXED-TASK\n    - MIXED-CHILD\n- [x] MIXED-DONE\n',
    required: ['MIXED-PARENT', '[ ] MIXED-TASK', 'MIXED-CHILD', '[x] MIXED-DONE'],
  },
  {
    name: 'list with code and image',
    source: '- LIST-CODE\n  ```js\n  LIST_ITEM_JS\n  ```\n- ![LIST_IMAGE](./list.png)\n',
    required: ['LIST-CODE', 'LIST_ITEM_JS', '![LIST_IMAGE](./list.png)'],
    nodes: [['codeBlock', 1], ['image', 1]],
  },
  {
    name: 'adjacent display formulas',
    source: '$$\nFIRST_ADJ\n$$\n\n$$\nSECOND_ADJ\n$$\n',
    required: ['FIRST_ADJ', 'SECOND_ADJ'],
    nodes: [['inlineMath', 2]],
  },
  {
    name: 'footnote reference and definition',
    source: 'FOOTNOTE_BODY[^deep]\n\n[^deep]: FOOTNOTE_DETAIL\n',
    required: ['FOOTNOTE_BODY', 'FOOTNOTE_DETAIL'],
    nodes: [['footnoteReference', 1], ['footnoteDefinition', 1]],
  },
  {
    name: 'table with rich cells',
    source: '| RICH | FORMULA | LINK |\n| --- | --- | --- |\n| `RICH_CODE` | $RICH_X^2$ | [RICH_LINK](https://example.com) |\n',
    required: ['RICH_CODE', 'RICH_X^2', 'RICH_LINK'],
    nodes: [['table', 1]],
  },
  {
    name: 'double quote with paragraph',
    source: '> > DOUBLE_DEEP\n',
    required: ['DOUBLE_DEEP'],
  },
];

for (const item of nestedInternalCases) {
  const origin = makeEditor(item.source);
  const target = makeEditor('');
  try {
    origin.commands.setTextSelection(1);
    origin.commands.selectAll();
    const payload = buildClipboardPayload(origin.view) as ClipboardPastePayload;
    paste(target, payload);
    const result = md(target);
    expectAll(result, item.required, `internal nested ${item.name}`);
    for (const [type, expectedCount] of item.nodes ?? []) {
      assert(`internal nested ${item.name} keeps ${type} count`, countNodes(target, type) === expectedCount, result);
    }
    assert(`internal nested ${item.name} is stable`, serializeMarkdown(parseMarkdown(result)) === result, `${result} vs ${serializeMarkdown(parseMarkdown(result))}`);
  } finally {
    origin.destroy();
    target.destroy();
  }
}

for (let iteration = 0; iteration < 24; iteration += 1) {
  const sourceDoc = [
    `# ROUND-${iteration}`,
    `Body-${iteration} has $a_${iteration}$ math.`,
    `- Bullet-${iteration}`,
    `| R${iteration} | V |\n| --- | --- |\n| Cell-${iteration} | Y |`,
    '```js\nconst round = ' + iteration + ';\n```',
  ].join('\n\n');
  const origin = makeEditor(sourceDoc);
  const target = makeEditor('');
  try {
    origin.commands.setTextSelection(1);
    origin.commands.selectAll();
    const payload = buildClipboardPayload(origin.view) as ClipboardPastePayload;
    paste(target, payload);
    const result = md(target);
    expectAll(result, [`ROUND-${iteration}`, `Body-${iteration}`, `a_${iteration}`, `Bullet-${iteration}`, `R${iteration}`, `Cell-${iteration}`, 'const round'], `internal round ${iteration}`);
    assert(`internal round ${iteration} keeps code`, countNodes(target, 'codeBlock') === 1, result);
    assert(`internal round ${iteration} keeps table`, countNodes(target, 'table') === 1, result);
  } finally {
    origin.destroy();
    target.destroy();
  }
}

console.log(`\n================================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
