<div align="center">

**English** | [简体中文](README.zh-CN.md)

# Marivell

**A calm, local-first Markdown workspace with live math, diagrams, and glass UI.**

[![Release](https://img.shields.io/github/v/release/BruceCui7193/marivell?style=for-the-badge)](https://github.com/BruceCui7193/marivell/releases)
[![License](https://img.shields.io/github/license/BruceCui7193/marivell?style=for-the-badge)](LICENSE)
[![Build](https://img.shields.io/github/actions/workflow/status/BruceCui7193/marivell/release.yml?style=for-the-badge)](https://github.com/BruceCui7193/marivell/actions)

</div>

![Marivell workspace](docs/screenshots/hero-light.png)

Marivell is a WYSIWYG Markdown editor for people who want the fluid feel of a document editor and the full control of Markdown. It is built with Electron, React, TypeScript, Tiptap, KaTeX, and Mermaid, and keeps your files local-first by default.

## The Editor

![Dark source mode](docs/screenshots/source-dark.png)

One maximized workspace shows task lists, KaTeX math, Mermaid diagrams, code, tables, footnotes, folder navigation, and the full toolbar. Source mode keeps raw Markdown, line numbers, and syntax highlighting one keystroke away.

## Why Marivell

- **WYSIWYG editing.** Edit the rendered document directly, instead of maintaining a separate preview pane.
- **Math that reads like math.** Inline and block LaTeX are rendered with KaTeX while you work.
- **Diagrams inside the document.** Mermaid charts stay editable and render in place.
- **Source mode when you need it.** Raw Markdown, line numbers, and syntax highlighting are one keystroke away.
- **Calm, configurable surfaces.** Frosted or liquid glass UI, light and dark modes, and multiple color palettes.
- **Local-first workflow.** Open folders, browse files, paste images, detect external changes, and export without a cloud account.

## Features

| Area | What Marivell does |
| --- | --- |
| Markdown | Headings, lists, task lists, blockquotes, tables, code blocks, links, footnotes, HTML blocks |
| Math | `$...$`, `$$...$$`, `\\(...\\)`, `\\[...\\]`, KaTeX rendering and LaTeX syntax highlighting |
| Diagrams | Mermaid flowcharts, sequence diagrams, state diagrams, Gantt charts, and more |
| Files | Folder sidebar, file tree, document outline, external change detection, multi-window |
| Images | Drag-and-drop, paste, save to document folder, save to default library, keep original path |
| Appearance | Light, dark, system theme; natural, forest, bay, warm paper, graphite, aurora, sakura, lavender, cyberpunk palettes; frosted glass, liquid glass, or solid UI |
| Export | PDF, 2x long image, and Pandoc formats: DOCX, HTML, EPUB, LaTeX, ODT, RTF, PPTX, plain text, GFM |
| Source mode | Raw Markdown editor with line numbers, search, go-to-line, and syntax highlighting |

## Quick Start

### Linux

From source, build and install the latest version:

```bash
npm run install:linux
```

If a release package is preferred, install the `.deb` or AppImage from [Releases](https://github.com/BruceCui7193/marivell/releases).

### Windows

Download the Windows installer from [Releases](https://github.com/BruceCui7193/marivell/releases). The installer includes an optional `.md` / `.markdown` file association, checked by default.

### Open a Markdown file

After installation you can open files from the terminal:

```bash
marivell document.md
```

## Development

Requirements: Node.js 20+, npm 10+.

```bash
npm install
npm run dev
```

## Test

```bash
npm test
```

The suite covers Markdown round-trips, source/visual mode switching, history, clipboard behavior, math, code blocks, images, footnotes, task lists, workflow stress cases, render-mode interaction/HTML regressions, and packaging assets. GitHub Actions runs the same tests before building releases.

## Performance Benchmark

```bash
npm run benchmark
npm run benchmark -- /path/to/a/large-markdown-file.md
```

Full methodology and current baseline results are in [docs/performance-benchmark.md](docs/performance-benchmark.md). A 2026-oriented, no-code-change long-term optimization plan is in [docs/performance-roadmap.md](docs/performance-roadmap.md). The benchmark builds a temporary bundle, launches Electron in visual/render mode, and measures:

- visual document open: file read, renderer render, and total open time
- an interaction suite: typing, bold, heading, list, inline/block math, table, code block, image, footnote, undo/redo, and a combined sequence
- visual editing latency after the document is ready
- scroll response and average/max frame time while scrolling
- right-click context menu open latency
- headless Markdown parse, serialize, syntax highlight, outline extraction, and formula counts

Results are printed as a table and written to `perf-report.json`. Set `MARIVELL_BENCHMARK_FILE` to choose the Markdown file without passing it as an argument. Timeouts can be tuned with `MARIVELL_BENCHMARK_OPEN_TIMEOUT_MS`, `MARIVELL_BENCHMARK_INTERACTION_TIMEOUT_MS`, and `MARIVELL_BENCHMARK_SUITE_TIMEOUT_MS`.

## Build

```bash
# Linux packages
npm run build:linux

# Windows installer
npm run build:win

# Local Linux unpacked build
npm run build:linux:dir
```

## File Associations

`.md` and `.markdown` file association configuration lives in [electron-builder.config.mjs](electron-builder.config.mjs).

- Windows: the NSIS installer can register `.md` / `.markdown` with Marivell and uses the custom document icons.
- Linux: the installer registers the MIME types and installs Markdown icons, so file managers show `.md` / `.markdown` files with Marivell icons and list Marivell in **Open With**.

## Keyboard Shortcuts

| Action | Shortcut |
| --- | --- |
| Save | `Ctrl+S` |
| Search / replace | `Ctrl+F` |
| Source mode | `Ctrl+Shift+E` |
| Export PDF | `Ctrl+Shift+P` |
| Export image | `Ctrl+Shift+I` |
| Toggle theme | `Ctrl+Shift+L` |
| Toggle sidebar | `Ctrl+\` |
| New window | `Ctrl+N` |
| Open file | `Ctrl+O` |
| Bold | `Ctrl+B` |
| Italic | `Ctrl+I` |

## Project Layout

```text
src/
  main/        Electron main process, desktop integration, export pipeline
  preload/     IPC bridge
  renderer/    React UI, editor, themes, clipboard, liquid glass
  shared/      Shared contracts and types
build/         Icons, desktop files, installer assets
tests/         Markdown fixtures and shared test assets
scripts/       Build, install, and test scripts
```

A ready-to-open demo document is available at [docs/demo/marivell.md](docs/demo/marivell.md).

## Tech Stack

Electron, electron-vite, React, TypeScript, Tiptap/ProseMirror, KaTeX, Mermaid, lowlight, remark, pngjs, electron-builder.

The liquid glass UI is a self-contained renderer adapted from the open-source [archisvaze/liquid-glass](https://github.com/archisvaze/liquid-glass) SVG displacement approach, with Marivell-specific backdrop sampling layers, animation, and performance tuning. See [liquid-glass.ts](src/renderer/effects/liquid-glass.ts).

## License

MIT
