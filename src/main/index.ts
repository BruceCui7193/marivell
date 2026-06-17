import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  type MenuItemConstructorOptions,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type WebContents,
} from 'electron';
import type {
  ExportStatus,
  FolderEntry,
  OpenedFolder,
  MenuAction,
  OpenedDocument,
  SaveDocumentPayload,
  SaveImagePayload,
  SavedDocument,
  ThemeMode,
  WindowDocumentState,
} from '@shared/contracts';

const APP_NAME = 'Markdown Editor Pro';
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const DIALOG_MARKDOWN_FILTERS = [
  { name: '\u004d\u0061\u0072\u006b\u0064\u006f\u0077\u006e \u6587\u6863', extensions: ['md', 'markdown'] },
  { name: '\u6240\u6709\u6587\u4ef6', extensions: ['*'] },
];
const EXPORT_PAGE_CSS = `
  :root {
    color-scheme: light;
    --export-bg: #ffffff;
    --export-text: #111827;
    --export-muted: #6b7280;
    --export-border: #d9dde3;
    --export-code-bg: #f4f6f8;
    --export-accent: #2f6f61;
  }

  * {
    box-sizing: border-box;
  }

  html,
  body {
    margin: 0;
    padding: 0;
    background: var(--export-bg);
    color: var(--export-text);
    font-family: "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif;
  }

  body {
    min-height: 100vh;
  }

  .export-page {
    width: 100%;
    background: #ffffff;
  }

  .export-document {
    width: min(860px, calc(100vw - 96px));
    margin: 0 auto;
    padding: 40px 0 48px;
  }

  .export-source {
    white-space: pre-wrap;
    word-break: break-word;
    font-family: "Cascadia Code", "JetBrains Mono", monospace;
    font-size: 14px;
    line-height: 1.7;
  }

  .export-document h1,
  .export-document h2,
  .export-document h3,
  .export-document h4,
  .export-document h5,
  .export-document h6 {
    font-family: inherit;
    font-weight: 700;
    line-height: 1.24;
    margin: 1.2em 0 0.55em;
    letter-spacing: 0;
    color: var(--export-text);
  }

  .export-document h1 { font-size: 2.2rem; }
  .export-document h2 { font-size: 1.76rem; }
  .export-document h3 { font-size: 1.35rem; }

  .export-document p,
  .export-document ul,
  .export-document ol,
  .export-document blockquote,
  .export-document pre,
  .export-document table,
  .export-document .footnote-definition-node,
  .export-document .math-block-node,
  .export-document .mermaid-node,
  .export-document .image-node {
    margin: 0.9rem 0;
  }

  .export-document a {
    color: var(--export-accent);
    text-decoration: none;
    border-bottom: 1px solid rgba(47, 111, 97, 0.28);
  }

  .export-document blockquote {
    border-left: 3px solid rgba(47, 111, 97, 0.24);
    padding-left: 16px;
    color: var(--export-muted);
  }

  .export-document ul,
  .export-document ol {
    padding-left: 1.5rem;
  }

  .export-document ul[data-type='taskList'] {
    list-style: none;
    padding-left: 0;
  }

  .export-document ul[data-type='taskList'] li {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .export-document pre {
    overflow: auto;
    border: 1px solid var(--export-border);
    border-radius: 16px;
    background: var(--export-code-bg);
    padding: 16px 18px;
    font-size: 0.92rem;
  }

  .export-document code,
  .export-source,
  .export-document .math-block-editor__textarea,
  .export-document .math-inline-node__input,
  .export-document .node-card__textarea,
  .export-document .image-node__textarea {
    font-family: "Cascadia Code", "JetBrains Mono", monospace;
  }

  .export-document p code {
    padding: 0.12em 0.35em;
    border-radius: 7px;
    background: var(--export-code-bg);
  }

  .export-document table {
    width: 100%;
    border-collapse: collapse;
    overflow: hidden;
    border-radius: 14px;
    border: 1px solid var(--export-border);
  }

  .export-document th,
  .export-document td {
    padding: 12px 14px;
    border-right: 1px solid var(--export-border);
    border-bottom: 1px solid var(--export-border);
    vertical-align: top;
  }

  .export-document th {
    background: #f4f7f7;
    text-align: left;
  }

  .export-document img,
  .export-document .image-node__image {
    display: block;
    max-width: 100%;
    border-radius: 16px;
  }

  .export-document .image-node,
  .export-document .math-block-node,
  .export-document .math-inline-node,
  .export-document .mermaid-node,
  .export-document .footnote-definition-node {
    padding: 0;
    background: transparent;
    border: none;
    box-shadow: none;
  }

  .export-document .image-node__editor,
  .export-document .math-block-editor,
  .export-document .mermaid-node__editor,
  .export-document .footnote-definition-node__meta,
  .export-document .image-node__error,
  .export-document .node-card__error {
    display: none !important;
  }

  .export-document .math-inline-editor {
    background: transparent;
    padding: 0;
  }

  .export-document .math-block-node__preview,
  .export-document .math-inline-node__preview,
  .export-document .mermaid-node__preview,
  .export-document .footnote-definition-node__content {
    padding: 0;
  }

  .export-document .footnote-reference {
    color: var(--export-accent);
    font-size: 0.8em;
  }

  .export-document .ProseMirror-selectednode,
  .export-document .ProseMirror-gapcursor,
  .export-document .ProseMirror-trailingBreak {
    display: none !important;
  }

  @page {
    size: A4;
    margin: 18mm;
  }

  @media print {
    html,
    body {
      background: #ffffff !important;
    }

    .export-page {
      background: #ffffff !important;
    }

    .export-document {
      width: auto;
      margin: 0;
      padding: 0;
    }
  }
`;

const windows = new Set<BrowserWindow>();
const pendingFilesOnLaunch: string[] = [];
const dirtyWindows = new WeakMap<BrowserWindow, boolean>();
const windowDocumentStates = new WeakMap<BrowserWindow, WindowDocumentState>();
const closeAllowedWindows = new WeakSet<BrowserWindow>();
const closePromptWindows = new WeakSet<BrowserWindow>();
const pendingCloseSaves = new Map<number, (saved: boolean) => void>();

interface WindowInitOptions {
  filePath?: string | null;
  folderPath?: string | null;
}

interface PersistedWindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
}

interface ExportSnapshot {
  title: string;
  html: string;
  mode: 'visual' | 'source';
}

const DEFAULT_WINDOW_STATE: PersistedWindowState = {
  width: 1380,
  height: 920,
  isMaximized: false,
};

const EMPTY_WINDOW_DOCUMENT_STATE: WindowDocumentState = {
  path: null,
  markdown: '',
  dirty: false,
};

async function readFolderEntries(folderPath: string): Promise<FolderEntry[]> {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const markdownFiles = entries.filter((entry) => entry.isFile() && isMarkdownPath(entry.name));

  const resolvedEntries = await Promise.all(
    markdownFiles.map(async (entry) => {
      const absolutePath = path.join(folderPath, entry.name);
      const stats = await fs.stat(absolutePath);

      return {
        path: absolutePath,
        title: entry.name,
        modifiedAt: stats.mtimeMs,
      };
    }),
  );

  return resolvedEntries.sort((left, right) => right.modifiedAt - left.modifiedAt);
}

async function readFolder(folderPath: string): Promise<OpenedFolder> {
  return {
    path: folderPath,
    entries: await readFolderEntries(folderPath),
  };
}

function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

async function readWindowState(): Promise<PersistedWindowState> {
  try {
    const raw = await fs.readFile(getWindowStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedWindowState>;

    return {
      width: Math.max(parsed.width ?? DEFAULT_WINDOW_STATE.width, 420),
      height: Math.max(parsed.height ?? DEFAULT_WINDOW_STATE.height, 680),
      x: parsed.x,
      y: parsed.y,
      isMaximized: Boolean(parsed.isMaximized),
    };
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

async function writeWindowState(state: PersistedWindowState): Promise<void> {
  await fs.mkdir(path.dirname(getWindowStatePath()), { recursive: true });
  await fs.writeFile(getWindowStatePath(), JSON.stringify(state, null, 2), 'utf8');
}

function captureWindowState(window: BrowserWindow): PersistedWindowState {
  const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();

  return {
    width: Math.max(bounds.width, 420),
    height: Math.max(bounds.height, 680),
    x: bounds.x,
    y: bounds.y,
    isMaximized: window.isMaximized(),
  };
}

function isMarkdownPath(filePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function getWindowFromSender(sender: WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(sender);
}

function getFocusedOrLastWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? [...windows].at(-1) ?? null;
}

function updateWindowTitle(window: BrowserWindow | null, title?: string): void {
  if (!window || window.isDestroyed()) {
    return;
  }

  window.setTitle(title ? `${title} - ${APP_NAME}` : APP_NAME);
}

function sanitizeFileNameSegment(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function extractSuggestedDocumentName(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      continue;
    }

    const heading = trimmed.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) {
      continue;
    }

    const candidate = sanitizeFileNameSegment(heading[1] ?? '');
    if (candidate) {
      return `${candidate}.md`;
    }
  }

  return 'untitled.md';
}

function isWindowDirty(window: BrowserWindow | null): boolean {
  if (!window || window.isDestroyed()) {
    return false;
  }

  return dirtyWindows.get(window) ?? false;
}

function markWindowDirty(window: BrowserWindow | null, dirty: boolean): void {
  if (!window || window.isDestroyed()) {
    return;
  }

  dirtyWindows.set(window, dirty);
  window.setDocumentEdited(dirty);
}

function markWindowDocumentState(window: BrowserWindow | null, state: WindowDocumentState): void {
  if (!window || window.isDestroyed()) {
    return;
  }

  windowDocumentStates.set(window, state);
}

function getWindowDocumentState(window: BrowserWindow | null): WindowDocumentState {
  if (!window || window.isDestroyed()) {
    return EMPTY_WINDOW_DOCUMENT_STATE;
  }

  return windowDocumentStates.get(window) ?? EMPTY_WINDOW_DOCUMENT_STATE;
}

function canReuseWindowForDocumentOpen(window: BrowserWindow | null): boolean {
  if (!window || window.isDestroyed()) {
    return false;
  }

  const state = getWindowDocumentState(window);
  return state.path === null && !state.dirty && state.markdown.trim().length === 0;
}

function getReusableDocumentWindow(preferredWindow?: BrowserWindow | null): BrowserWindow | null {
  const candidate = preferredWindow ?? getFocusedOrLastWindow();
  return canReuseWindowForDocumentOpen(candidate) ? candidate : null;
}

function requestRendererSaveBeforeClose(window: BrowserWindow): Promise<boolean> {
  const webContentsId = window.webContents.id;

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      pendingCloseSaves.delete(webContentsId);
      resolve(false);
    }, 30_000);

    pendingCloseSaves.set(webContentsId, (saved) => {
      clearTimeout(timeoutId);
      resolve(saved);
    });

    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      pendingCloseSaves.delete(webContentsId);
      clearTimeout(timeoutId);
      resolve(false);
      return;
    }

    window.webContents.send('window:request-save-before-close');
  });
}

async function promptBeforeClose(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed() || closePromptWindows.has(window)) {
    return;
  }

  closePromptWindows.add(window);

  try {
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: ['\u4fdd\u5b58\u5e76\u5173\u95ed', '\u4e0d\u4fdd\u5b58', '\u53d6\u6d88'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: '\u672a\u4fdd\u5b58\u7684\u4fee\u6539',
      message: '\u5f53\u524d\u6587\u6863\u6709\u672a\u4fdd\u5b58\u7684\u4fee\u6539\u3002',
      detail: '\u5173\u95ed\u7a97\u53e3\u524d\uff0c\u662f\u5426\u5148\u4fdd\u5b58\u5f53\u524d\u6587\u6863\uff1f',
    });

    if (response === 2) {
      return;
    }

    if (response === 0) {
      const saved = await requestRendererSaveBeforeClose(window);
      if (!saved || window.isDestroyed()) {
        return;
      }
    }

    markWindowDirty(window, false);
    closeAllowedWindows.add(window);
    window.close();
  } finally {
    closePromptWindows.delete(window);
  }
}
async function readDocument(filePath: string): Promise<OpenedDocument> {
  const markdown = await fs.readFile(filePath, 'utf8');

  return {
    path: filePath,
    markdown,
    title: path.basename(filePath),
  };
}

async function writeDocument(targetPath: string, markdown: string): Promise<SavedDocument> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, markdown, 'utf8');

  return {
    path: targetPath,
    markdown,
    title: path.basename(targetPath),
  };
}

function getDocumentTitleFromWindow(window: BrowserWindow): string {
  const suffix = ` - ${APP_NAME}`;
  const title = window.getTitle();

  if (title.endsWith(suffix)) {
    return title.slice(0, -suffix.length);
  }

  return title || APP_NAME;
}

function buildExportFileName(window: BrowserWindow, extension: 'pdf' | 'png'): string {
  const baseName = sanitizeFileNameSegment(
    getDocumentTitleFromWindow(window).replace(/\.(md|markdown)$/i, ''),
  );

  return `${baseName || 'document'}.${extension}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function readKatexExportCss(): Promise<string> {
  const candidateDirectories = [
    path.join(app.getAppPath(), 'node_modules', 'katex', 'dist'),
    path.join(process.cwd(), 'node_modules', 'katex', 'dist'),
    path.join(path.dirname(app.getPath('exe')), 'resources', 'app.asar', 'node_modules', 'katex', 'dist'),
    path.join(path.dirname(app.getPath('exe')), 'resources', 'app', 'node_modules', 'katex', 'dist'),
  ];

  try {
    const katexDirectory = candidateDirectories.find((directory) =>
      existsSync(path.join(directory, 'katex.min.css')),
    );

    if (!katexDirectory) {
      return '';
    }

    const katexPath = path.join(katexDirectory, 'katex.min.css');
    const css = await fs.readFile(katexPath, 'utf8');
    const fontsBaseUrl = `${pathToFileURL(path.join(katexDirectory, 'fonts')).toString()}/`;

    return css
      .replace(/url\((['"]?)(?:\.\.\/)?fonts\//g, `url($1${fontsBaseUrl}`)
      .replace(/src:\s*local\('Arial'\);/g, '');
  } catch {
    return '';
  }
}

async function captureExportSnapshot(window: BrowserWindow): Promise<ExportSnapshot | null> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    return null;
  }

  return window.webContents.executeJavaScript(`
    (() => {
      const surface = document.querySelector('.editor-surface');
      const source = document.querySelector('.editor-source');

      if (surface instanceof HTMLElement) {
        const clone = surface.cloneNode(true);
        const container = document.createElement('div');
        container.appendChild(clone);

        const normalizePreviewNode = (selector, previewSelector, className) => {
          container.querySelectorAll(selector).forEach((element) => {
            const preview = element.querySelector(previewSelector);
            if (!(preview instanceof HTMLElement)) {
              return;
            }

            const wrapper = document.createElement(element.tagName.toLowerCase());
            wrapper.className = className;
            wrapper.innerHTML = preview.innerHTML;
            element.replaceWith(wrapper);
          });
        };

        container.querySelectorAll('[contenteditable]').forEach((element) => {
          element.removeAttribute('contenteditable');
        });

        container.querySelectorAll('[data-outline-index]').forEach((element) => {
          element.removeAttribute('data-outline-index');
        });

        container.querySelectorAll('.ProseMirror-selectednode, .ProseMirror-gapcursor, .ProseMirror-trailingBreak').forEach((element) => {
          element.remove();
        });

        const sourceImages = Array.from(surface.querySelectorAll('img'));
        const cloneImages = Array.from(container.querySelectorAll('img'));
        cloneImages.forEach((image, index) => {
          const sourceImage = sourceImages[index];
          const resolvedSource = sourceImage?.currentSrc || sourceImage?.src || image.getAttribute('src') || '';
          if (resolvedSource) {
            image.setAttribute('src', resolvedSource);
          }
        });

        normalizePreviewNode('.math-inline-node', '.math-inline-node__preview, .math-inline-editor__preview', 'math-inline-node');
        normalizePreviewNode('.math-block-node', '.math-block-node__preview, .math-block-editor__preview', 'math-block-node');
        normalizePreviewNode('.mermaid-node', '.mermaid-node__preview', 'mermaid-node');

        container.querySelectorAll('.image-node').forEach((element) => {
          const image = element.querySelector('.image-node__image, .image-node__preview img, img');
          if (!(image instanceof HTMLImageElement)) {
            return;
          }

          const wrapper = document.createElement('div');
          wrapper.className = 'image-node';
          wrapper.appendChild(image.cloneNode(true));
          element.replaceWith(wrapper);
        });

        return {
          title: document.title,
          mode: 'visual',
          html: container.innerHTML,
        };
      }

      if (source instanceof HTMLTextAreaElement) {
        return {
          title: document.title,
          mode: 'source',
          html: source.value,
        };
      }

      return null;
    })()
  `);
}

function buildExportHtml(snapshot: ExportSnapshot, katexCss: string): string {
  const bodyContent =
    snapshot.mode === 'source'
      ? `<pre class="export-source">${escapeHtml(snapshot.html)}</pre>`
      : snapshot.html;

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(snapshot.title)}</title>
    <style>${katexCss}</style>
    <style>${EXPORT_PAGE_CSS}</style>
  </head>
  <body>
    <div class="export-page">
      <main class="export-document">${bodyContent}</main>
    </div>
  </body>
</html>`;
}

async function createExportWindow(html: string): Promise<BrowserWindow> {
  const exportDirectory = await fs.mkdtemp(path.join(app.getPath('temp'), 'markdown-editor-export-'));
  const exportFilePath = path.join(exportDirectory, 'export.html');
  await fs.writeFile(exportFilePath, html, 'utf8');

  const exportWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      sandbox: false,
    },
  });

  await exportWindow.loadFile(exportFilePath);
  await exportWindow.webContents.executeJavaScript(`
    (async () => {
      const images = Array.from(document.images);
      await Promise.all(images.map((image) => {
        if (image.complete) {
          return Promise.resolve();
        }

        return new Promise((resolve) => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
        });
      }));

      if (document.fonts?.ready) {
        await document.fonts.ready;
      }

      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()
  `);

  exportWindow.on('closed', () => {
    void fs.rm(exportDirectory, { recursive: true, force: true });
  });

  return exportWindow;
}

async function prepareExportWindow(window: BrowserWindow): Promise<BrowserWindow | null> {
  const snapshot = await captureExportSnapshot(window);
  if (!snapshot) {
    return null;
  }

  const katexCss = await readKatexExportCss();
  const html = buildExportHtml(snapshot, katexCss);
  return createExportWindow(html);
}

async function getExportDocumentBounds(window: BrowserWindow): Promise<{
  width: number;
  height: number;
} | null> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    return null;
  }

  return window.webContents.executeJavaScript(`
    (() => {
      const element = document.querySelector('.export-page');
      if (!element) {
        return null;
      }

      const rect = element.getBoundingClientRect();
      return {
        width: Math.max(1, Math.ceil(rect.width)),
        height: Math.max(1, Math.ceil(document.documentElement.scrollHeight)),
      };
    })()
  `);
}

async function stitchPngSlices(slices: Buffer[]): Promise<Buffer> {
  if (slices.length === 0) {
    throw new Error('No PNG slices were captured');
  }

  const { PNG } = await import('pngjs');
  const decodedSlices = slices.map((slice) => PNG.sync.read(slice));
  const outputWidth = decodedSlices[0]?.width ?? 0;
  const outputHeight = decodedSlices.reduce((total, slice) => total + slice.height, 0);

  if (outputWidth <= 0 || outputHeight <= 0) {
    throw new Error('Invalid stitched PNG dimensions');
  }

  const output = new PNG({
    width: outputWidth,
    height: outputHeight,
  });

  let offsetY = 0;
  for (const slice of decodedSlices) {
    PNG.bitblt(slice, output, 0, 0, slice.width, slice.height, 0, offsetY);
    offsetY += slice.height;
  }

  return PNG.sync.write(output);
}

async function captureExportWindowPng(
  window: BrowserWindow,
  bounds: { width: number; height: number },
  onProgress?: (current: number, total: number) => void,
): Promise<Buffer> {
  const screenshotSlices: Buffer[] = [];
  const totalWidth = Math.max(1, Math.ceil(bounds.width));
  const totalHeight = Math.max(1, Math.ceil(bounds.height));
  const chunkHeight = 2048;
  const chunkCount = Math.max(1, Math.ceil(totalHeight / chunkHeight));

  try {
    await window.webContents.executeJavaScript(`
      document.documentElement.style.scrollBehavior = 'auto';
      document.body.style.scrollBehavior = 'auto';
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      window.scrollTo(0, 0);
    `);

    for (let offset = 0, chunkIndex = 0; offset < totalHeight; offset += chunkHeight, chunkIndex += 1) {
      const currentHeight = Math.min(chunkHeight, totalHeight - offset);
      onProgress?.(chunkIndex + 1, chunkCount);

      window.setContentSize(totalWidth, currentHeight);

      await window.webContents.executeJavaScript(`
        new Promise((resolve) => {
          document.documentElement.scrollTop = ${offset};
          document.body.scrollTop = ${offset};
          window.scrollTo(0, ${offset});
          requestAnimationFrame(() => requestAnimationFrame(() => {
            setTimeout(resolve, 24);
          }));
        })
      `);

      const image = await window.webContents.capturePage({
        x: 0,
        y: 0,
        width: totalWidth,
        height: currentHeight,
      });

      const png = image.toPNG();
      if (png.length === 0) {
        throw new Error('Failed to capture PNG slice');
      }

      screenshotSlices.push(png);
    }

    const buffer = await stitchPngSlices(screenshotSlices);
    if (buffer.length === 0) {
      throw new Error('Exported PNG is empty');
    }

    return buffer;
  } finally {
    window.setContentSize(1200, 900);
  }
}

async function exportWindowAsPdf(window: BrowserWindow): Promise<void> {
  sendExportStatus(window, {
    active: true,
    message: '\u6b63\u5728\u51c6\u5907 PDF \u5bfc\u51fa\u2026',
  });

  const saveResult = await dialog.showSaveDialog(window, {
    title: '\u5bfc\u51fa PDF',
    defaultPath: buildExportFileName(window, 'pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });

  if (saveResult.canceled || !saveResult.filePath || window.webContents.isDestroyed()) {
    sendExportStatus(window, {
      active: false,
      message: '',
    });
    return;
  }

  const exportWindow = await prepareExportWindow(window);
  if (!exportWindow) {
    sendExportStatus(window, {
      active: false,
      message: '',
    });
    return;
  }

  try {
    sendExportStatus(window, {
      active: true,
      message: '\u6b63\u5728\u751f\u6210 PDF \u2026',
    });

    const pdf = await exportWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      landscape: false,
      pageSize: 'A4',
      margins: {
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
      },
    });

    await fs.writeFile(saveResult.filePath, pdf);
    sendExportStatus(window, {
      active: true,
      message: '\u5df2\u5b8c\u6210 PDF \u5bfc\u51fa',
    });
  } finally {
    if (!exportWindow.isDestroyed()) {
      exportWindow.close();
    }

    setTimeout(() => {
      sendExportStatus(window, {
        active: false,
        message: '',
      });
    }, 900);
  }
}

async function exportWindowAsImage(window: BrowserWindow): Promise<void> {
  sendExportStatus(window, {
    active: true,
    message: '\u6b63\u5728\u5bfc\u51fa\u56fe\u7247\u2026',
  });

  const saveResult = await dialog.showSaveDialog(window, {
    title: '\u5bfc\u51fa\u56fe\u7247',
    defaultPath: buildExportFileName(window, 'png'),
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  });

  if (saveResult.canceled || !saveResult.filePath) {
    sendExportStatus(window, {
      active: false,
      message: '',
    });
    return;
  }

  const exportWindow = await prepareExportWindow(window);
  if (!exportWindow) {
    sendExportStatus(window, {
      active: false,
      message: '',
    });
    return;
  }

  try {
    sendExportStatus(window, {
      active: true,
      message: '\u6b63\u5728\u5bfc\u51fa\u56fe\u7247\u2026',
    });

    const bounds = await getExportDocumentBounds(exportWindow);
    if (!bounds) {
      throw new Error('Failed to measure export document');
    }

    const png = await captureExportWindowPng(exportWindow, bounds, (current, total) => {
      sendExportStatus(window, {
        active: true,
        message:
          total > 1
            ? `\u6b63\u5728\u5bfc\u51fa\u56fe\u7247\u2026 (${current}/${total})`
            : '\u6b63\u5728\u5bfc\u51fa\u56fe\u7247\u2026',
      });
    });
    await fs.writeFile(saveResult.filePath, png);
    sendExportStatus(window, {
      active: true,
      message: '\u5df2\u5b8c\u6210\u56fe\u7247\u5bfc\u51fa',
    });
  } finally {
    if (!exportWindow.isDestroyed()) {
      exportWindow.close();
    }

    setTimeout(() => {
      sendExportStatus(window, {
        active: false,
        message: '',
      });
    }, 900);
  }
}

function sendMenuAction(action: MenuAction, window?: BrowserWindow | null): void {
  const targetWindow = window ?? getFocusedOrLastWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  targetWindow.webContents.send('menu:action', action);
}

function sendExportStatus(window: BrowserWindow, status: ExportStatus): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    return;
  }

  window.webContents.send('export:status', status);
}

function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '\u6587\u4ef6',
      submenu: [
        {
          label: '\u65b0\u5efa\u7a97\u53e3',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            void createMainWindow();
          },
        },
        {
          label: '\u6253\u5f00\u6587\u4ef6...',
          accelerator: 'CmdOrCtrl+O',
          click: (_item, browserWindow: any) => {
            void openDocumentPickerInNewWindow(browserWindow as any);
          },
        },
        {
          label: '\u6253\u5f00\u6587\u4ef6\u5939...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: (_item, browserWindow: any) => {
            void openFolderPickerInNewWindow(browserWindow as any);
          },
        },
        { type: 'separator' },
        {
          label: '\u4fdd\u5b58',
          accelerator: 'CmdOrCtrl+S',
          click: (_item, browserWindow: any) => sendMenuAction('save-document', browserWindow),
        },
        {
          label: '\u53e6\u5b58\u4e3a...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: (_item, browserWindow: any) => sendMenuAction('save-document-as', browserWindow),
        },
        { type: 'separator' },
        {
          label: '\u5bfc\u51fa PDF...',
          click: (_item, browserWindow: any) => {
            const targetWindow = browserWindow ?? getFocusedOrLastWindow();
            if (targetWindow) {
              void exportWindowAsPdf(targetWindow as any);
            }
          },
        },
        {
          label: '\u5bfc\u51fa\u56fe\u7247...',
          click: (_item, browserWindow: any) => {
            const targetWindow = browserWindow ?? getFocusedOrLastWindow();
            if (targetWindow) {
              void exportWindowAsImage(targetWindow as any);
            }
          },
        },
        { type: 'separator' },
        { role: 'quit', label: '\u9000\u51fa' },
      ],
    },
    {
      label: '\u7f16\u8f91',
      submenu: [
        { role: 'undo', label: '\u64a4\u9500' },
        { role: 'redo', label: '\u91cd\u505a' },
        { type: 'separator' },
        { role: 'cut', label: '\u526a\u5207' },
        { role: 'copy', label: '\u590d\u5236' },
        { role: 'paste', label: '\u7c98\u8d34' },
        { role: 'selectAll', label: '\u5168\u9009' },
      ],
    },
    {
      label: '\u89c6\u56fe',
      submenu: [
        {
          label: '\u663e\u793a/\u9690\u85cf\u5de5\u5177\u680f',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: (_item, browserWindow: any) => sendMenuAction('toggle-toolbar', browserWindow),
        },
        {
          label: '\u663e\u793a/\u9690\u85cf\u4fa7\u680f',
          accelerator: 'CmdOrCtrl+\\',
          click: (_item, browserWindow: any) => sendMenuAction('toggle-sidebar', browserWindow),
        },
        {
          label: '\u5207\u6362\u6e90\u7801\u6a21\u5f0f',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: (_item, browserWindow: any) => sendMenuAction('toggle-source-mode', browserWindow),
        },
        {
          label: '\u5207\u6362\u4e3b\u9898',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: (_item, browserWindow: any) => sendMenuAction('toggle-theme', browserWindow),
        },
        { type: 'separator' },
        { role: 'reload', label: '\u91cd\u65b0\u52a0\u8f7d' },
        { role: 'toggleDevTools', label: '\u5f00\u53d1\u8005\u5de5\u5177' },
        { role: 'resetZoom', label: '\u91cd\u7f6e\u7f29\u653e' },
        { role: 'zoomIn', label: '\u653e\u5927' },
        { role: 'zoomOut', label: '\u7f29\u5c0f' },
      ],
    },
    {
      label: '\u7a97\u53e3',
      submenu: [
        { role: 'minimize', label: '\u6700\u5c0f\u5316' },
        { role: 'close', label: '\u5173\u95ed' },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

async function openDocumentInWindow(window: BrowserWindow, filePath: string): Promise<void> {
  if (!isMarkdownPath(filePath)) {
    return;
  }

  const document = await readDocument(filePath);
  updateWindowTitle(window, document.title);
  markWindowDirty(window, false);
  markWindowDocumentState(window, {
    path: document.path,
    markdown: document.markdown,
    dirty: false,
  });
  window.webContents.send('document:opened', document);
}

async function openDocumentInPreferredWindow(
  filePath: string,
  preferredWindow?: BrowserWindow | null,
): Promise<boolean> {
  const reusableWindow = getReusableDocumentWindow(preferredWindow);
  if (reusableWindow) {
    await openDocumentInWindow(reusableWindow, filePath);
    if (reusableWindow.isMinimized()) {
      reusableWindow.restore();
    }
    reusableWindow.focus();
    return false;
  }

  await createMainWindow({ filePath });
  return true;
}

async function openDocumentPicker(parentWindow?: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(parentWindow as any, {
    title: '\u6253\u5f00 Markdown \u6587\u6863',
    properties: ['openFile'],
    filters: DIALOG_MARKDOWN_FILTERS,
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
}

async function openFolderPicker(parentWindow?: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(parentWindow as any, {
    title: '\u6253\u5f00\u6587\u4ef6\u5939',
    properties: ['openDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
}

async function openDocumentPickerInNewWindow(parentWindow?: BrowserWindow): Promise<boolean> {
  const filePath = await openDocumentPicker(parentWindow);
  if (!filePath) {
    return false;
  }

  return openDocumentInPreferredWindow(filePath, parentWindow ?? null);
}

async function openFolderPickerInNewWindow(parentWindow?: BrowserWindow): Promise<boolean> {
  const folderPath = await openFolderPicker(parentWindow);
  if (!folderPath) {
    return false;
  }

  await createMainWindow({ folderPath });
  return true;
}

function resolveWindowIcon(): string | undefined {
  const platform = process.platform;
  const iconName = platform === 'win32' ? 'icon.ico' : 'icon.png';
  const iconPath = path.join(process.cwd(), 'build', iconName);

  if (existsSync(iconPath)) {
    return iconPath;
  }

  return undefined;
}

async function createMainWindow(options: WindowInitOptions = {}): Promise<BrowserWindow> {
  const { filePath = null, folderPath = null } = options;
  const windowState = await readWindowState();
  const windowInstance = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 420,
    minHeight: 680,
    show: false,
    backgroundColor: '#f3f4f2',
    icon: resolveWindowIcon(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const webContentsId = windowInstance.webContents.id;
  let windowStateSaveTimer: NodeJS.Timeout | null = null;

  const scheduleWindowStateSave = () => {
    if (windowInstance.isDestroyed()) {
      return;
    }

    if (windowStateSaveTimer) {
      clearTimeout(windowStateSaveTimer);
    }

    windowStateSaveTimer = setTimeout(() => {
      if (windowInstance.isDestroyed()) {
        return;
      }

      void writeWindowState(captureWindowState(windowInstance));
    }, 160);
  };

  windows.add(windowInstance);
  dirtyWindows.set(windowInstance, false);
  windowDocumentStates.set(windowInstance, EMPTY_WINDOW_DOCUMENT_STATE);
  updateWindowTitle(windowInstance);

  windowInstance.on('ready-to-show', () => {
    if (windowState.isMaximized) {
      windowInstance.maximize();
    }
    windowInstance.show();
  });

  windowInstance.on('closed', () => {
    if (windowStateSaveTimer) {
      clearTimeout(windowStateSaveTimer);
      windowStateSaveTimer = null;
    }

    windows.delete(windowInstance);
    const pendingSave = pendingCloseSaves.get(webContentsId);
    if (pendingSave) {
      pendingCloseSaves.delete(webContentsId);
      pendingSave(false);
    }
  });

  windowInstance.on('close', (event) => {
    if (closeAllowedWindows.has(windowInstance) || !isWindowDirty(windowInstance)) {
      void writeWindowState(captureWindowState(windowInstance));
      return;
    }

    event.preventDefault();
    void promptBeforeClose(windowInstance);
  });

  windowInstance.on('query-session-end', (event) => {
    if (closeAllowedWindows.has(windowInstance) || !isWindowDirty(windowInstance)) {
      return;
    }

    event.preventDefault();
    void promptBeforeClose(windowInstance);
  });

  windowInstance.on('move', scheduleWindowStateSave);
  windowInstance.on('resize', scheduleWindowStateSave);
  windowInstance.on('maximize', scheduleWindowStateSave);
  windowInstance.on('unmaximize', scheduleWindowStateSave);

  windowInstance.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  windowInstance.webContents.on('did-finish-load', () => {
    if (filePath) {
      void openDocumentInWindow(windowInstance, filePath);
    }

    if (folderPath) {
      void readFolder(folderPath).then((folder) => {
        windowInstance.webContents.send('folder:opened', folder);
      });
    }
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    await windowInstance.loadURL(rendererUrl);
  } else {
    await windowInstance.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return windowInstance;
}

function getInitialFilePath(argv: string[]): string | null {
  for (const value of argv) {
    if (isMarkdownPath(value) && path.isAbsolute(value)) {
      return value;
    }
  }

  return null;
}

function ensureSingleInstance(): void {
  const lock = app.requestSingleInstanceLock();

  if (!lock) {
    app.quit();
    return;
  }

  app.on('second-instance', (_event, argv) => {
    const filePath = getInitialFilePath(argv);

    if (filePath) {
      void openDocumentInPreferredWindow(filePath);
      return;
    }

    void createMainWindow();
  });
}

function registerFileOpenHandlers(): void {
  app.on('open-file', (event, filePath) => {
    event.preventDefault();

    if (!isMarkdownPath(filePath)) {
      return;
    }

    if (!app.isReady()) {
      pendingFilesOnLaunch.push(filePath);
      return;
    }

    void openDocumentInPreferredWindow(filePath);
  });
}

function createAssetDirectory(documentPath: string): string {
  const extension = path.extname(documentPath);
  const stem = path.basename(documentPath, extension);
  return path.join(path.dirname(documentPath), `${stem}.assets`);
}

function buildImageName(originalName: string): string {
  const extension = path.extname(originalName) || '.png';
  const stem = path.basename(originalName, extension).replace(/[^\w-]+/g, '-');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stem || 'image'}-${timestamp}${extension}`;
}

async function saveImage(payload: SaveImagePayload) {
  if (!payload.currentPath) {
    return {
      kind: 'data-url' as const,
      markdownPath: `data:image/png;base64,${payload.base64}`,
    };
  }

  const assetDirectory = createAssetDirectory(payload.currentPath);
  await fs.mkdir(assetDirectory, { recursive: true });

  const fileName = buildImageName(payload.suggestedName);
  const absolutePath = path.join(assetDirectory, fileName);

  await fs.writeFile(absolutePath, Buffer.from(payload.base64, 'base64'));

  const markdownPath = path
    .relative(path.dirname(payload.currentPath), absolutePath)
    .replace(/\\/g, '/');

  return {
    kind: 'file' as const,
    markdownPath,
    absolutePath,
  };
}

async function exportClipboardDebugBundle(): Promise<string | null> {
  const formats = clipboard.availableFormats();
  const text = clipboard.readText();
  const html = clipboard.readHTML();
  const rtf = clipboard.readRTF();

  if (!text && !html && !rtf && formats.length === 0) {
    return null;
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '')
    .replace('T', '-');
  const baseName = `clipboard-debug-${timestamp}`;
  const desktopPath = app.getPath('desktop');
  const jsonPath = path.join(desktopPath, `${baseName}.json`);
  const htmlPath = path.join(desktopPath, `${baseName}.html`);
  const textPath = path.join(desktopPath, `${baseName}.txt`);
  const rtfPath = path.join(desktopPath, `${baseName}.rtf`);

  const metadata = {
    createdAt: new Date().toISOString(),
    formats,
    textLength: text.length,
    htmlLength: html.length,
    rtfLength: rtf.length,
  };

  await fs.writeFile(jsonPath, JSON.stringify(metadata, null, 2), 'utf8');
  await fs.writeFile(htmlPath, html, 'utf8');
  await fs.writeFile(textPath, text, 'utf8');
  await fs.writeFile(rtfPath, rtf, 'utf8');

  return jsonPath;
}

function registerIpcHandlers(): void {
  ipcMain.handle('window:new', async () => {
    await createMainWindow();
  });

  ipcMain.handle('window:set-dirty', async (event, dirty: boolean) => {
    const parentWindow = getWindowFromSender(event.sender);
    markWindowDirty(parentWindow, dirty);
  });

  ipcMain.handle('window:set-document-state', async (event, state: WindowDocumentState) => {
    const parentWindow = getWindowFromSender(event.sender);
    markWindowDocumentState(parentWindow, state);
  });

  ipcMain.on('window:save-before-close-result', (event, saved: boolean) => {
    const resolver = pendingCloseSaves.get(event.sender.id);
    if (!resolver) {
      return;
    }

    pendingCloseSaves.delete(event.sender.id);
    resolver(saved);
  });

  ipcMain.handle('dialog:open-document', async (event) => {
    const parentWindow = getWindowFromSender(event.sender) ?? undefined;
    const filePath = await openDocumentPicker(parentWindow);
    if (!filePath) {
      return null;
    }

    const document = await readDocument(filePath);
    updateWindowTitle(parentWindow ?? null, document.title);
    return document;
  });

  ipcMain.handle('dialog:open-document-new-window', async (event) => {
    const parentWindow = getWindowFromSender(event.sender) ?? undefined;
    return openDocumentPickerInNewWindow(parentWindow);
  });

  ipcMain.handle('document:open-path', async (event, filePath: string) => {
    const parentWindow = getWindowFromSender(event.sender);
    const document = await readDocument(filePath);
    updateWindowTitle(parentWindow, document.title);
    return document;
  });

  ipcMain.handle('dialog:open-folder', async (event) => {
    const parentWindow = getWindowFromSender(event.sender) ?? undefined;
    const folderPath = await openFolderPicker(parentWindow);
    if (!folderPath) {
      return null;
    }

    return readFolder(folderPath);
  });

  ipcMain.handle('dialog:open-folder-new-window', async (event) => {
    const parentWindow = getWindowFromSender(event.sender) ?? undefined;
    return openFolderPickerInNewWindow(parentWindow);
  });

  ipcMain.handle('folder:read', async (_event, folderPath: string) => {
    return readFolder(folderPath);
  });

  ipcMain.handle('document:save', async (event, payload: SaveDocumentPayload) => {
    const parentWindow = getWindowFromSender(event.sender);

    if (!payload.currentPath) {
      const saveResult = await dialog.showSaveDialog(parentWindow as any, {
        title: '\u4fdd\u5b58 Markdown \u6587\u6863',
        defaultPath: extractSuggestedDocumentName(payload.markdown),
        filters: DIALOG_MARKDOWN_FILTERS,
      });

      if (saveResult.canceled || !saveResult.filePath) {
        return null;
      }

      const document = await writeDocument(saveResult.filePath, payload.markdown);
      updateWindowTitle(parentWindow, document.title);
      return document;
    }

    const document = await writeDocument(payload.currentPath, payload.markdown);
    updateWindowTitle(parentWindow, document.title);
    return document;
  });

  ipcMain.handle('document:save-as', async (event, payload: SaveDocumentPayload) => {
    const parentWindow = getWindowFromSender(event.sender);
    const defaultPath = payload.currentPath ?? extractSuggestedDocumentName(payload.markdown);
    const saveResult = await dialog.showSaveDialog(parentWindow as any, {
      title: 'Markdown \u6587\u6863\u53e6\u5b58\u4e3a',
      defaultPath,
      filters: DIALOG_MARKDOWN_FILTERS,
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return null;
    }

    const document = await writeDocument(saveResult.filePath, payload.markdown);
    updateWindowTitle(parentWindow, document.title);
    return document;
  });

  ipcMain.handle('asset:save-image', async (_event, payload: SaveImagePayload) => {
    return saveImage(payload);
  });

  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    await shell.openExternal(url);
  });

  ipcMain.handle('clipboard:export-debug', async () => {
    return exportClipboardDebugBundle();
  });

  ipcMain.handle('theme:set', async (_event, theme: ThemeMode) => {
    nativeTheme.themeSource = theme;
  });
}

ensureSingleInstance();
registerFileOpenHandlers();
registerIpcHandlers();

app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildMenu());

  const initialPath = getInitialFilePath(process.argv.slice(1));
  if (initialPath) {
    pendingFilesOnLaunch.push(initialPath);
  }

  if (pendingFilesOnLaunch.length > 0) {
    for (const filePath of pendingFilesOnLaunch.splice(0)) {
      await createMainWindow({ filePath });
    }
  } else {
    await createMainWindow();
  }

  app.on('activate', () => {
    if (windows.size === 0) {
      void createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

