import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  BenchmarkAppMetrics,
  ExportDocumentPayload,
  ExportStatus,
  ExternalFileChangeAck,
  ExternalFileChangeEvent,
  MarkdownEditorApi,
  MenuAction,
  OpenedDocument,
  OpenedFolder,
  PandocExportFormat,
  PandocExportOptions,
  SaveDocumentPayload,
  SaveImagePayload,
  ThemeMode,
  WindowDocumentState,
} from '@shared/contracts';

const api: MarkdownEditorApi = {
  newWindow: () => ipcRenderer.invoke('window:new'),
  getUltimateU2Enabled: () => process.env.MARIVELL_ULTIMATE_U2 === '1',
  openDocumentDialog: () => ipcRenderer.invoke('dialog:open-document'),
  openDocumentDialogInNewWindow: () => ipcRenderer.invoke('dialog:open-document-new-window'),
  openDocumentPath: (filePath: string) => ipcRenderer.invoke('document:open-path', filePath),
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
  openFolderDialogInNewWindow: () => ipcRenderer.invoke('dialog:open-folder-new-window'),
  readFolder: (folderPath: string) => ipcRenderer.invoke('folder:read', folderPath),
  saveDocument: (payload: SaveDocumentPayload) => ipcRenderer.invoke('document:save', payload),
  saveDocumentAs: (payload: SaveDocumentPayload) => ipcRenderer.invoke('document:save-as', payload),
  saveImage: (payload: SaveImagePayload) => ipcRenderer.invoke('asset:save-image', payload),
  chooseImageDirectory: () => ipcRenderer.invoke('dialog:choose-image-directory'),
  getPathForFile: (file: unknown) => webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  exportClipboardDebug: () => ipcRenderer.invoke('clipboard:export-debug'),
  exportAsPdf: (payload: ExportDocumentPayload) => ipcRenderer.invoke('export:pdf', payload),
  exportAsImage: (payload: ExportDocumentPayload) => ipcRenderer.invoke('export:image', payload),
  exportWithPandoc: (
    payload: ExportDocumentPayload,
    format: PandocExportFormat,
    options?: PandocExportOptions,
  ) => ipcRenderer.invoke('export:pandoc', payload, format, options),
  getExportCapabilities: () => ipcRenderer.invoke('export:capabilities'),
  getPandocTemplates: () => ipcRenderer.invoke('export:pandoc-templates'),
  setPandocTemplate: (format, templatePath) =>
    ipcRenderer.invoke('export:pandoc-template-set', format, templatePath),
  choosePandocTemplate: (format) => ipcRenderer.invoke('export:pandoc-template-choose', format),
  getAppInfo: () => ipcRenderer.invoke('settings:app-info'),
  checkForUpdates: (includePrerelease: boolean) =>
    ipcRenderer.invoke('settings:check-updates', includePrerelease),
  getAppMetrics: () =>
    ipcRenderer.invoke('benchmark:app-metrics') as Promise<BenchmarkAppMetrics>,
  reportBenchmarkMetric: (name: string, value: number) =>
    ipcRenderer.send('benchmark:record', { name, value }),
  getBenchmarkTimeline: () => ipcRenderer.invoke('benchmark:timeline'),
  getBenchmarkEnabled: () => process.env.MARIVELL_BENCHMARK === '1',
  setTheme: (theme: ThemeMode) => ipcRenderer.invoke('theme:set', theme),
  zoomIn: () => ipcRenderer.invoke('window:zoom-in'),
  zoomOut: () => ipcRenderer.invoke('window:zoom-out'),
  zoomReset: () => ipcRenderer.invoke('window:zoom-reset'),
  setWindowDirty: (dirty: boolean) => ipcRenderer.invoke('window:set-dirty', dirty),
  setWindowDocumentState: (state: WindowDocumentState) =>
    ipcRenderer.invoke('window:set-document-state', state),
  respondSaveBeforeClose: (saved: boolean) => {
    ipcRenderer.send('window:save-before-close-result', saved);
  },
  acknowledgeExternalFileChange: (payload: ExternalFileChangeAck) =>
    ipcRenderer.invoke('file:external-change-ack', payload),
  onDocumentOpened: (callback: (document: OpenedDocument) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, document: OpenedDocument) => {
      callback(document);
    };

    ipcRenderer.on('document:opened', listener);
    return () => {
      ipcRenderer.removeListener('document:opened', listener);
    };
  },
  onFolderOpened: (callback: (folder: OpenedFolder) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, folder: OpenedFolder) => {
      callback(folder);
    };

    ipcRenderer.on('folder:opened', listener);
    return () => {
      ipcRenderer.removeListener('folder:opened', listener);
    };
  },
  onExportStatus: (callback: (status: ExportStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: ExportStatus) => {
      callback(status);
    };

    ipcRenderer.on('export:status', listener);
    return () => {
      ipcRenderer.removeListener('export:status', listener);
    };
  },
  onRequestSaveBeforeClose: (callback: () => void) => {
    const listener = () => {
      callback();
    };

    ipcRenderer.on('window:request-save-before-close', listener);
    return () => {
      ipcRenderer.removeListener('window:request-save-before-close', listener);
    };
  },
  onMenuAction: (callback: (action: MenuAction) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: MenuAction) => {
      callback(action);
    };

    ipcRenderer.on('menu:action', listener);
    return () => {
      ipcRenderer.removeListener('menu:action', listener);
    };
  },
  onExternalFileChange: (callback: (event: ExternalFileChangeEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: ExternalFileChangeEvent) => {
      callback(event);
    };

    ipcRenderer.on('file:external-change', listener);
    return () => {
      ipcRenderer.removeListener('file:external-change', listener);
    };
  },
  onExportPandocRequest: (
    callback: (format: PandocExportFormat, options?: PandocExportOptions) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      format: PandocExportFormat,
      options?: PandocExportOptions,
    ) => {
      callback(format, options);
    };

    ipcRenderer.on('export:pandoc-request', listener);
    return () => {
      ipcRenderer.removeListener('export:pandoc-request', listener);
    };
  },
};

contextBridge.exposeInMainWorld('markdownEditor', api);
