import { existsSync, promises as fs, statSync, watch, type FSWatcher } from 'node:fs';
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
  screen,
  shell,
  type WebContents,
} from 'electron';

/**
 * Linux desktop launches often fail hard when:
 * - chrome-sandbox is present but not root-owned + setuid (unpacked / wrong .desktop path)
 * - GPU process cannot start (NVIDIA hybrid, zygote, etc.)
 * Apply safe Chromium flags *before* app ready.
 */
function configureLinuxChromiumFlags(): void {
  if (process.platform !== 'linux') {
    return;
  }

  // GPU sandbox is a frequent source of error_code=1002 / "GPU process isn't usable".
  app.commandLine.appendSwitch('disable-gpu-sandbox');

  const sandboxPath = path.join(path.dirname(process.execPath), 'chrome-sandbox');
  try {
    if (existsSync(sandboxPath)) {
      const st = statSync(sandboxPath);
      const isSetuidRoot = st.uid === 0 && (st.mode & 0o4000) !== 0;
      if (!isSetuidRoot) {
        // chrome-sandbox present but not root+setuid: Chromium FATALS unless we
        // disable the setuid helper (no-sandbox alone is not always enough).
        app.commandLine.appendSwitch('disable-setuid-sandbox');
        app.commandLine.appendSwitch('no-sandbox');
      }
    }
  } catch {
    app.commandLine.appendSwitch('disable-setuid-sandbox');
    app.commandLine.appendSwitch('no-sandbox');
  }
}

configureLinuxChromiumFlags();
import type {
  ExportDocumentPayload,
  FolderEntry,
  OpenedFolder,
  MenuAction,
  OpenedDocument,
  PandocExportFormat,
  SaveDocumentPayload,
  SaveImagePayload,
  SavedDocument,
  ThemeMode,
  WindowDocumentState,
} from '@shared/contracts';
import {
  exportDocumentAsImage,
  exportDocumentAsPdf,
  exportDocumentWithPandoc,
  getExportCapabilities,
  getPandocTemplates,
  getTemplateSupport,
  PANDOC_FORMATS,
  pickPandocTemplate,
  updatePandocTemplate,
} from './export';
import { checkForUpdates, getAppInfo } from './settings';

const APP_NAME = 'Marivell';
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const DIALOG_MARKDOWN_FILTERS = [
  { name: '\u004d\u0061\u0072\u006b\u0064\u006f\u0077\u006e \u6587\u6863', extensions: ['md', 'markdown'] },
  { name: '\u6240\u6709\u6587\u4ef6', extensions: ['*'] },
];

function getDialogParent(parentWindow: any): any {
  if (process.platform === 'linux') {
    return undefined;
  }
  return parentWindow;
}

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
    const width = Math.max(parsed.width ?? DEFAULT_WINDOW_STATE.width, 420);
    const height = Math.max(parsed.height ?? DEFAULT_WINDOW_STATE.height, 680);

    // Clamp to a visible display so a stale position after dock/monitor changes
    // does not leave the window "opened" off-screen (common after a crash).
    let x = parsed.x;
    let y = parsed.y;
    if (typeof x === 'number' && typeof y === 'number') {
      const nearest = screen.getDisplayNearestPoint({ x, y });
      const bounds = nearest.workArea;
      const maxX = bounds.x + Math.max(bounds.width - width, 0);
      const maxY = bounds.y + Math.max(bounds.height - height, 0);
      if (x < bounds.x - 40 || y < bounds.y - 40 || x > maxX + 40 || y > maxY + 40) {
        x = bounds.x + Math.floor((bounds.width - width) / 2);
        y = bounds.y + Math.floor((bounds.height - height) / 2);
      } else {
        x = Math.min(Math.max(x, bounds.x), maxX);
        y = Math.min(Math.max(y, bounds.y), maxY);
      }
    }

    return {
      width,
      height,
      x,
      y,
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
    pendingCloseSaves.set(webContentsId, (saved) => {
      resolve(saved);
    });

    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      pendingCloseSaves.delete(webContentsId);
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
    const shouldClose = await requestRendererSaveBeforeClose(window);
    if (!shouldClose || window.isDestroyed()) {
      return;
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

// --- External file change detection ---

const fileWatchers = new Map<string, FSWatcher>();
const fileChangeTimers = new Map<string, NodeJS.Timeout>();
/** Ignore watcher events until this timestamp (own saves, reloads). */
const fileWatchIgnoreUntil = new Map<string, number>();
/** Last mtime we already notified the renderer about. */
const fileWatchLastNotifiedMtime = new Map<string, number>();
/** Paths waiting for the user to answer the external-change prompt. */
const fileWatchPromptPending = new Set<string>();

function stopWatchingFile(filePath: string): void {
  const watcher = fileWatchers.get(filePath);
  if (watcher) {
    watcher.close();
    fileWatchers.delete(filePath);
  }

  const timer = fileChangeTimers.get(filePath);
  if (timer) {
    clearTimeout(timer);
    fileChangeTimers.delete(filePath);
  }

  fileWatchIgnoreUntil.delete(filePath);
  fileWatchLastNotifiedMtime.delete(filePath);
  fileWatchPromptPending.delete(filePath);
}

function ignoreFileWatchEvents(filePath: string, durationMs = 1600): void {
  fileWatchIgnoreUntil.set(filePath, Date.now() + durationMs);
}

async function rememberFileWatchMtime(filePath: string): Promise<void> {
  try {
    if (!existsSync(filePath)) {
      return;
    }
    const stats = await fs.stat(filePath);
    fileWatchLastNotifiedMtime.set(filePath, stats.mtimeMs);
  } catch {
    // ignore
  }
}

function startWatchingFile(
  filePath: string,
  window: BrowserWindow,
): void {
  // Preserve ignore / mtime bookkeeping across restarts of the same path;
  // only tear down the native watcher + debounce timer.
  const watcher = fileWatchers.get(filePath);
  if (watcher) {
    watcher.close();
    fileWatchers.delete(filePath);
  }
  const timer = fileChangeTimers.get(filePath);
  if (timer) {
    clearTimeout(timer);
    fileChangeTimers.delete(filePath);
  }

  if (!existsSync(filePath)) {
    return;
  }

  // Seed baseline mtime so opening a file does not immediately "change".
  void rememberFileWatchMtime(filePath);

  try {
    const nextWatcher = watch(filePath, () => {
      const existingTimer = fileChangeTimers.get(filePath);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      fileChangeTimers.set(
        filePath,
        setTimeout(() => {
          fileChangeTimers.delete(filePath);
          void (async () => {
            if (window.isDestroyed()) {
              stopWatchingFile(filePath);
              return;
            }

            if (Date.now() < (fileWatchIgnoreUntil.get(filePath) ?? 0)) {
              return;
            }

            // One prompt at a time per file — prevents stacked confirms.
            if (fileWatchPromptPending.has(filePath)) {
              return;
            }

            const deleted = !existsSync(filePath);
            if (deleted) {
              fileWatchPromptPending.add(filePath);
              window.webContents.send('file:external-change', {
                path: filePath,
                kind: 'deleted',
                title: path.basename(filePath),
              });
              stopWatchingFile(filePath);
              return;
            }

            try {
              const stats = await fs.stat(filePath);
              const lastMtime = fileWatchLastNotifiedMtime.get(filePath);
              if (lastMtime !== undefined && stats.mtimeMs === lastMtime) {
                return;
              }

              fileWatchLastNotifiedMtime.set(filePath, stats.mtimeMs);
              fileWatchPromptPending.add(filePath);
              window.webContents.send('file:external-change', {
                path: filePath,
                kind: 'changed',
                title: path.basename(filePath),
              });
            } catch {
              // File may have vanished between exists check and stat.
            }
          })();
        }, 350),
      );
    });

    fileWatchers.set(filePath, nextWatcher);
  } catch {
    // fs.watch may fail on some filesystems; ignore silently
  }
}

function acknowledgeExternalFileChange(
  filePath: string,
  options: { reloaded?: boolean; dismissed?: boolean } = {},
): void {
  fileWatchPromptPending.delete(filePath);
  if (options.reloaded) {
    ignoreFileWatchEvents(filePath, 1600);
    void rememberFileWatchMtime(filePath);
  }
  // dismissed: keep lastNotifiedMtime so the same revision does not re-prompt
}

function getDocumentTitleFromWindow(window: BrowserWindow): string {
  const suffix = ` - ${APP_NAME}`;
  const title = window.getTitle();

  if (title.endsWith(suffix)) {
    return title.slice(0, -suffix.length);
  }

  return title || APP_NAME;
}

function sendMenuAction(action: MenuAction, window?: BrowserWindow | null): void {
  const targetWindow = window ?? getFocusedOrLastWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  targetWindow.webContents.send('menu:action', action);
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
          label: '导出 PDF...',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: (_item, browserWindow: any) => sendMenuAction('export-pdf', browserWindow),
        },
        {
          label: '导出长图...',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: (_item, browserWindow: any) => sendMenuAction('export-image', browserWindow),
        },
        {
          label: '通过 Pandoc 导出',
          submenu: [
            ...PANDOC_FORMATS.map((format) => ({
              label: format.label,
              click: (_item: unknown, browserWindow: any) => {
                const targetWindow =
                  (browserWindow as BrowserWindow | undefined) ?? getFocusedOrLastWindow();
                if (!targetWindow || targetWindow.isDestroyed()) {
                  return;
                }
                targetWindow.webContents.send(
                  'export:pandoc-request',
                  format.id as PandocExportFormat,
                );
              },
            })),
            { type: 'separator' as const },
            {
              label: '使用模板导出…',
              submenu: PANDOC_FORMATS.filter((format) => getTemplateSupport(format.id).flag).map(
                (format) => ({
                  label: `${format.label}（选模板）`,
                  click: (_item: unknown, browserWindow: any) => {
                    const targetWindow =
                      (browserWindow as BrowserWindow | undefined) ?? getFocusedOrLastWindow();
                    if (!targetWindow || targetWindow.isDestroyed()) {
                      return;
                    }
                    targetWindow.webContents.send(
                      'export:pandoc-request',
                      format.id as PandocExportFormat,
                      { chooseTemplate: true },
                    );
                  },
                }),
              ),
            },
            {
              label: '设置默认模板…',
              submenu: [
                ...PANDOC_FORMATS.filter((format) => getTemplateSupport(format.id).flag).map(
                  (format) => ({
                    label: `设置 ${format.label} 模板…`,
                    click: (_item: unknown, browserWindow: any) => {
                      const targetWindow =
                        (browserWindow as BrowserWindow | undefined) ?? getFocusedOrLastWindow();
                      void pickPandocTemplate(targetWindow, format.id);
                    },
                  }),
                ),
                { type: 'separator' as const },
                ...PANDOC_FORMATS.filter((format) => getTemplateSupport(format.id).flag).map(
                  (format) => ({
                    label: `清除 ${format.label} 模板`,
                    click: () => {
                      void updatePandocTemplate(format.id as PandocExportFormat, null);
                    },
                  }),
                ),
              ],
            },
          ],
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

  // Stop watching previous file for this window
  const previousState = getWindowDocumentState(window);
  if (previousState.path) {
    stopWatchingFile(previousState.path);
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

  // Start watching for external changes
  startWatchingFile(filePath, window);
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
  const result = await dialog.showOpenDialog(getDialogParent(parentWindow), {
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
  const result = await dialog.showOpenDialog(getDialogParent(parentWindow), {
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
  // Never rely on process.cwd() — desktop-menu launches often use $HOME or /.
  const candidates = [
    path.join(process.resourcesPath ?? '', iconName),
    path.join(process.resourcesPath ?? '', 'build', iconName),
    path.join(path.dirname(process.execPath), iconName),
    path.join(path.dirname(process.execPath), 'resources', iconName),
    path.join(app.getAppPath(), 'build', iconName),
    path.join(process.cwd(), 'build', iconName),
  ];

  for (const iconPath of candidates) {
    if (iconPath && existsSync(iconPath)) {
      return iconPath;
    }
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
    autoHideMenuBar: true,
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
    windowInstance.focus();
  });

  // If the renderer stalls, still surface the window so the user is not stuck
  // with a process holding the single-instance lock and no visible UI.
  setTimeout(() => {
    if (!windowInstance.isDestroyed() && !windowInstance.isVisible()) {
      windowInstance.show();
      windowInstance.focus();
    }
  }, 2500);

  windowInstance.webContents.on('render-process-gone', (_event, details) => {
    console.error('[marivell] render process gone', details);
    if (!windowInstance.isDestroyed()) {
      dialog.showErrorBox(
        APP_NAME,
        `渲染进程异常退出（${details.reason}）。\n窗口将关闭；请从菜单重新打开应用。`,
      );
      windowInstance.destroy();
    }
  });

  windowInstance.on('closed', () => {
    if (windowStateSaveTimer) {
      clearTimeout(windowStateSaveTimer);
      windowStateSaveTimer = null;
    }

    // Stop all file watchers for this window
    const state = getWindowDocumentState(windowInstance);
    if (state.path) {
      stopWatchingFile(state.path);
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
    try {
      await windowInstance.loadFile(path.join(__dirname, '../renderer/index.html'));
    } catch (error) {
      console.error('[marivell] failed to load renderer', error);
      dialog.showErrorBox(
        APP_NAME,
        `无法加载界面文件。\n\n${error instanceof Error ? error.message : String(error)}\n\n若从应用菜单启动失败，请确认桌面快捷方式指向 /opt/marivell 安装目录（不要指向项目里的 dist/linux-unpacked）。`,
      );
      throw error;
    }
  }

  return windowInstance;
}

function getInitialFilePath(argv: string[]): string | null {
  for (const value of argv) {
    if (!value || value.startsWith('-')) {
      continue;
    }
    // Desktop launchers may pass file:// URIs.
    let candidate = value;
    if (candidate.startsWith('file://')) {
      try {
        candidate = decodeURIComponent(new URL(candidate).pathname);
      } catch {
        continue;
      }
    }
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
    if (isMarkdownPath(absolute) && existsSync(absolute)) {
      return absolute;
    }
  }

  return null;
}

function focusExistingWindows(): boolean {
  const alive = [...windows].filter((win) => !win.isDestroyed());
  if (alive.length === 0) {
    return false;
  }

  for (const win of alive) {
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
  }

  // Raise the last focused / most recent window.
  const target = BrowserWindow.getFocusedWindow() ?? alive[alive.length - 1];
  target?.moveTop();
  target?.focus();
  return true;
}

function ensureSingleInstance(): void {
  const lock = app.requestSingleInstanceLock();

  if (!lock) {
    // Another instance owns the lock. Quit immediately so the primary can
    // handle second-instance (focus/restore). Do not leave a zombie process.
    app.exit(0);
    return;
  }

  app.on('second-instance', (_event, argv) => {
    const filePath = getInitialFilePath(argv);

    if (filePath) {
      void openDocumentInPreferredWindow(filePath).finally(() => {
        focusExistingWindows();
      });
      return;
    }

    // Menu re-click: bring existing window forward instead of no-op / silent quit.
    if (!focusExistingWindows()) {
      void createMainWindow();
    }
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

function createDefaultImageDirectory(): string {
  return path.join(app.getPath('userData'), 'assets');
}

function buildImageName(originalName: string): string {
  const extension = path.extname(originalName) || '.png';
  const stem = path.basename(originalName, extension).replace(/[^\w-]+/g, '-');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stem || 'image'}-${timestamp}${extension}`;
}

async function saveImage(payload: SaveImagePayload) {
  const destination = payload.destination ?? 'default';
  const targetDirectory =
    destination === 'document' && payload.currentPath
      ? createAssetDirectory(payload.currentPath)
      : destination === 'other' && payload.targetDirectory
        ? payload.targetDirectory
        : createDefaultImageDirectory();

  await fs.mkdir(targetDirectory, { recursive: true });

  const fileName = buildImageName(payload.suggestedName);
  const absolutePath = path.join(targetDirectory, fileName);

  if (payload.sourcePath) {
    if (payload.sourcePath !== absolutePath) {
      await fs.copyFile(payload.sourcePath, absolutePath);
    }
  } else {
    await fs.writeFile(absolutePath, Buffer.from(payload.base64 ?? '', 'base64'));
  }

  let markdownPath = absolutePath;
  if (payload.currentPath) {
    const documentDirectory = path.dirname(payload.currentPath);
    const relativePath = path.relative(documentDirectory, absolutePath);
    if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
      markdownPath = relativePath.replace(/\\/g, '/');
    }
  }

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

  ipcMain.handle('window:zoom-in', async (event) => {
    const parentWindow = getWindowFromSender(event.sender);
    parentWindow?.webContents.setZoomLevel((parentWindow.webContents.getZoomLevel() ?? 0) + 0.5);
  });

  ipcMain.handle('window:zoom-out', async (event) => {
    const parentWindow = getWindowFromSender(event.sender);
    parentWindow?.webContents.setZoomLevel((parentWindow.webContents.getZoomLevel() ?? 0) - 0.5);
  });

  ipcMain.handle('window:zoom-reset', async (event) => {
    const parentWindow = getWindowFromSender(event.sender);
    parentWindow?.webContents.setZoomLevel(0);
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
    if (parentWindow && !parentWindow.isDestroyed()) {
      // Treat programmatic open/reload as our own load so the watcher does not
      // immediately re-fire against the same file contents.
      const previous = getWindowDocumentState(parentWindow);
      if (previous.path && previous.path !== document.path) {
        stopWatchingFile(previous.path);
      }
      ignoreFileWatchEvents(document.path);
      markWindowDirty(parentWindow, false);
      markWindowDocumentState(parentWindow, {
        path: document.path,
        markdown: document.markdown,
        dirty: false,
      });
      startWatchingFile(document.path, parentWindow);
      void rememberFileWatchMtime(document.path);
      acknowledgeExternalFileChange(document.path, { reloaded: true });
    }
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
      const saveResult = await dialog.showSaveDialog(getDialogParent(parentWindow), {
        title: '\u4fdd\u5b58 Markdown \u6587\u6863',
        defaultPath: extractSuggestedDocumentName(payload.markdown),
        filters: DIALOG_MARKDOWN_FILTERS,
      });

      if (saveResult.canceled || !saveResult.filePath) {
        return null;
      }

      const document = await writeDocument(saveResult.filePath, payload.markdown);
      updateWindowTitle(parentWindow, document.title);
      if (parentWindow && !parentWindow.isDestroyed()) {
        ignoreFileWatchEvents(document.path);
        startWatchingFile(document.path, parentWindow);
        void rememberFileWatchMtime(document.path);
      }
      return document;
    }

    const document = await writeDocument(payload.currentPath, payload.markdown);
    updateWindowTitle(parentWindow, document.title);
    if (parentWindow && !parentWindow.isDestroyed()) {
      ignoreFileWatchEvents(document.path);
      startWatchingFile(document.path, parentWindow);
      void rememberFileWatchMtime(document.path);
    }
    return document;
  });

  ipcMain.handle('document:save-as', async (event, payload: SaveDocumentPayload) => {
    const parentWindow = getWindowFromSender(event.sender);
    const defaultPath = payload.currentPath ?? extractSuggestedDocumentName(payload.markdown);
    const saveResult = await dialog.showSaveDialog(getDialogParent(parentWindow), {
      title: 'Markdown \u6587\u6863\u53e6\u5b58\u4e3a',
      defaultPath,
      filters: DIALOG_MARKDOWN_FILTERS,
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return null;
    }

    const document = await writeDocument(saveResult.filePath, payload.markdown);
    updateWindowTitle(parentWindow, document.title);
    if (parentWindow && !parentWindow.isDestroyed()) {
      ignoreFileWatchEvents(document.path);
      startWatchingFile(document.path, parentWindow);
      void rememberFileWatchMtime(document.path);
    }
    return document;
  });

  ipcMain.handle(
    'file:external-change-ack',
    async (_event, payload: { path: string; reloaded?: boolean; dismissed?: boolean }) => {
      if (!payload?.path) {
        return;
      }
      acknowledgeExternalFileChange(payload.path, {
        reloaded: Boolean(payload.reloaded),
        dismissed: Boolean(payload.dismissed),
      });
    },
  );

  ipcMain.handle('asset:save-image', async (_event, payload: SaveImagePayload) => {
    return saveImage(payload);
  });

  ipcMain.handle('dialog:choose-image-directory', async (event) => {
    const parentWindow = getWindowFromSender(event.sender);
    const result = await dialog.showOpenDialog(getDialogParent(parentWindow), {
      title: '选择图片保存位置',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    await shell.openExternal(url);
  });

  ipcMain.handle('clipboard:export-debug', async () => {
    return exportClipboardDebugBundle();
  });

  ipcMain.handle('export:pdf', async (event, payload: ExportDocumentPayload) => {
    const window = getWindowFromSender(event.sender);
    return exportDocumentAsPdf(window, payload);
  });

  ipcMain.handle('export:image', async (event, payload: ExportDocumentPayload) => {
    const window = getWindowFromSender(event.sender);
    return exportDocumentAsImage(window, payload);
  });

  ipcMain.handle(
    'export:pandoc',
    async (
      event,
      payload: ExportDocumentPayload,
      format: PandocExportFormat,
      options?: { templatePath?: string | null; chooseTemplate?: boolean },
    ) => {
      const window = getWindowFromSender(event.sender);
      return exportDocumentWithPandoc(window, payload, format, options ?? {});
    },
  );

  ipcMain.handle('export:capabilities', async () => {
    return getExportCapabilities();
  });

  ipcMain.handle('export:pandoc-templates', async () => {
    return getPandocTemplates();
  });

  ipcMain.handle(
    'export:pandoc-template-set',
    async (_event, format: PandocExportFormat, templatePath: string | null) => {
      return updatePandocTemplate(format, templatePath);
    },
  );

  ipcMain.handle(
    'export:pandoc-template-choose',
    async (event, format: PandocExportFormat) => {
      const window = getWindowFromSender(event.sender);
      return pickPandocTemplate(window, format);
    },
  );

  ipcMain.handle('settings:app-info', () => getAppInfo());
  ipcMain.handle('settings:check-updates', (_event, includePrerelease: boolean) =>
    checkForUpdates(Boolean(includePrerelease)),
  );

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
