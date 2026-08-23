/** Professional, print-first styles for PDF / long-image export. */
export const EXPORT_PAGE_CSS = `
  :root {
    color-scheme: light;
    --bg: #ffffff;
    --text: #1a1d23;
    --muted: #5c6570;
    --border: #e2e6eb;
    --code-bg: #f6f8fa;
    --code-border: #e8ecf0;
    --accent: #0f6e56;
    --accent-soft: rgba(15, 110, 86, 0.12);
    --table-head: #f3f6f8;
    --quote-bg: #f8fafb;
    --radius: 10px;
    --content-width: 720px;
    --font-body: "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI",
      "Noto Sans CJK SC", "Source Han Sans SC", sans-serif;
    --font-mono: "Cascadia Code", "JetBrains Mono", "SF Mono", "Fira Code",
      "Sarasa Mono SC", ui-monospace, monospace;
    --font-math: KaTeX_Main, "Times New Roman", serif;
  }

  * { box-sizing: border-box; }

  html, body {
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-body);
    font-size: 16px;
    line-height: 1.75;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  body {
    min-height: 100%;
  }

  .export-page {
    width: 100%;
    background: var(--bg);
  }

  .export-document {
    width: min(var(--content-width), 100%);
    margin: 0 auto;
    padding: 48px 40px 64px;
  }

  .export-document > :first-child { margin-top: 0 !important; }
  .export-document > :last-child { margin-bottom: 0 !important; }

  h1, h2, h3, h4, h5, h6 {
    font-weight: 700;
    line-height: 1.3;
    color: var(--text);
    letter-spacing: -0.01em;
    page-break-after: avoid;
    break-after: avoid-page;
  }

  h1 { font-size: 2rem; margin: 0 0 1rem; padding-bottom: 0.45rem; border-bottom: 1px solid var(--border); }
  h2 { font-size: 1.55rem; margin: 2rem 0 0.75rem; padding-bottom: 0.3rem; border-bottom: 1px solid var(--border); }
  h3 { font-size: 1.28rem; margin: 1.6rem 0 0.6rem; }
  h4 { font-size: 1.1rem; margin: 1.35rem 0 0.5rem; }
  h5, h6 { font-size: 1rem; margin: 1.2rem 0 0.45rem; color: var(--muted); }

  p { margin: 0.85rem 0; orphans: 3; widows: 3; }

  a {
    color: var(--accent);
    text-decoration: none;
    border-bottom: 1px solid var(--accent-soft);
  }

  strong { font-weight: 700; }
  em { font-style: italic; }
  del { text-decoration: line-through; opacity: 0.8; }

  ul, ol {
    margin: 0.85rem 0;
    padding-left: 1.6rem;
  }

  li { margin: 0.28rem 0; }
  li > ul, li > ol { margin: 0.25rem 0; }

  ul.contains-task-list,
  ul.task-list {
    list-style: none;
    padding-left: 0.15rem;
  }

  li.task-list-item {
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
    list-style: none;
  }

  li.task-list-item input[type="checkbox"] {
    margin-top: 0.4rem;
    width: 0.95rem;
    height: 0.95rem;
    accent-color: var(--accent);
    flex-shrink: 0;
  }

  blockquote {
    margin: 1rem 0;
    padding: 0.65rem 1rem;
    border-left: 4px solid var(--accent);
    background: var(--quote-bg);
    color: var(--muted);
    border-radius: 0 var(--radius) var(--radius) 0;
  }

  blockquote p { margin: 0.35rem 0; }

  hr {
    border: none;
    border-top: 1px solid var(--border);
    margin: 1.75rem 0;
  }

  pre, .code-block {
    margin: 1rem 0;
    padding: 0.95rem 1.1rem;
    background: var(--code-bg);
    border: 1px solid var(--code-border);
    border-radius: var(--radius);
    overflow: auto;
    font-family: var(--font-mono);
    font-size: 0.875rem;
    line-height: 1.55;
    page-break-inside: avoid;
    break-inside: avoid;
  }

  pre code {
    background: none;
    padding: 0;
    border-radius: 0;
    font-size: inherit;
    color: inherit;
  }

  :not(pre) > code {
    font-family: var(--font-mono);
    font-size: 0.88em;
    padding: 0.12em 0.4em;
    border-radius: 5px;
    background: var(--code-bg);
    border: 1px solid var(--code-border);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 1rem 0;
    font-size: 0.95rem;
    page-break-inside: avoid;
    break-inside: avoid;
  }

  th, td {
    border: 1px solid var(--border);
    padding: 0.55rem 0.75rem;
    vertical-align: top;
    text-align: left;
  }

  th {
    background: var(--table-head);
    font-weight: 600;
  }

  tr:nth-child(even) td { background: #fafbfc; }

  img {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 1rem auto;
    border-radius: 8px;
  }

  figure {
    margin: 1.1rem 0;
    page-break-inside: avoid;
  }

  figcaption {
    text-align: center;
    color: var(--muted);
    font-size: 0.9rem;
    margin-top: 0.4rem;
  }

  /* KaTeX */
  .katex { font-size: 1.08em; }
  .katex-display {
    margin: 1.1rem 0;
    overflow-x: auto;
    overflow-y: hidden;
    page-break-inside: avoid;
    break-inside: avoid;
  }

  .math-block,
  .math-inline {
    page-break-inside: avoid;
  }

  .math-block {
    margin: 1.1rem 0;
    text-align: center;
  }

  /* One blank line after $$ separates blocks; it is not another visual gap. */
  .math-block {
    margin-bottom: 0;
    padding-bottom: 0;
  }
  .math-block .katex-display { margin-bottom: 0; }
  .math-block + p { margin-top: 0; }
  .math-block[data-trailing-blank-lines]::after {
    content: "";
    display: block;
    height: calc(var(--marivell-math-blank-lines, 0) * 1.75em);
  }

  .math-error {
    color: #b42318;
    background: #fef3f2;
    border: 1px solid #fecdca;
    border-radius: 6px;
    padding: 0.2em 0.45em;
    font-family: var(--font-mono);
    font-size: 0.85em;
  }

  /* Mermaid */
  .mermaid-block {
    margin: 1.15rem 0;
    padding: 1rem;
    background: #fbfcfd;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    text-align: center;
    overflow-x: auto;
    page-break-inside: avoid;
    break-inside: avoid;
  }

  .mermaid-block svg {
    max-width: 100%;
    height: auto;
  }

  .mermaid-error {
    color: #b42318;
    font-size: 0.9rem;
    text-align: left;
    white-space: pre-wrap;
    font-family: var(--font-mono);
  }

  .footnote-ref {
    font-size: 0.75em;
    vertical-align: super;
    color: var(--accent);
    margin: 0 0.1em;
  }

  .footnotes {
    margin-top: 2.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
    font-size: 0.92rem;
    color: var(--muted);
  }

  .footnotes h2 {
    font-size: 1rem;
    border: none;
    margin: 0 0 0.75rem;
    color: var(--muted);
  }

  .footnote-item {
    margin: 0.45rem 0;
  }

  .export-meta {
    display: none;
  }

  /* Image export: slightly tighter page */
  body.is-image-export .export-document {
    padding: 40px 36px 52px;
  }

  @page {
    size: A4;
    margin: 16mm 14mm 18mm;
  }

  @media print {
    html, body {
      background: #fff !important;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .katex-display {
      overflow: hidden;
    }

    .export-document {
      width: auto;
      max-width: none;
      margin: 0;
      padding: 0;
    }

    a { border-bottom: none; }
    pre, table, .mermaid-block, .katex-display, .math-block, img, figure {
      page-break-inside: avoid;
      break-inside: avoid;
    }

    h1, h2, h3, h4 {
      page-break-after: avoid;
      break-after: avoid-page;
    }
  }
`;
