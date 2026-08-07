export type ThemeMode = 'system' | 'light' | 'dark';

export type MenuAction =
  | 'new-document'
  | 'open-document'
  | 'open-folder'
  | 'save-document'
  | 'save-document-as'
  | 'toggle-theme'
  | 'toggle-source-mode'
  | 'toggle-toolbar'
  | 'toggle-sidebar'
  | 'export-pdf'
  | 'export-image'
  | 'export-pandoc';

export type PandocExportFormat =
  | 'docx'
  | 'html'
  | 'odt'
  | 'epub'
  | 'latex'
  | 'rtf'
  | 'plain'
  | 'pptx'
  | 'gfm';

export interface ExportDocumentPayload {
  markdown: string;
  title: string;
  documentPath: string | null;
}

export interface ExportCapabilities {
  pandocAvailable: boolean;
  pandocVersion: string | null;
  formats: Array<{
    id: PandocExportFormat;
    label: string;
    extension: string;
    filterName: string;
  }>;
  templates: PandocTemplateMap;
}

export interface OpenedDocument {
  path: string;
  markdown: string;
  title: string;
}

export interface FolderEntry {
  path: string;
  title: string;
  modifiedAt: number;
}

export interface OpenedFolder {
  path: string;
  entries: FolderEntry[];
}

export interface SavedDocument {
  path: string;
  markdown: string;
  title: string;
}

export interface SaveDocumentPayload {
  markdown: string;
  currentPath: string | null;
}

export type ImageSaveDestination = 'default' | 'document' | 'other';

export interface SaveImagePayload {
  base64?: string;
  sourcePath?: string | null;
  suggestedName: string;
  currentPath: string | null;
  destination?: ImageSaveDestination;
  targetDirectory?: string | null;
}

export interface SavedImage {
  markdownPath: string;
  absolutePath: string;
  kind: 'file' | 'data-url';
}

export interface ExportStatus {
  active: boolean;
  message: string;
}

export interface WindowDocumentState {
  path: string | null;
  markdown: string;
  dirty: boolean;
}

export interface AppInfo {
  name: string;
  version: string;
  platform: NodeJS.Platform;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string | null;
  hasUpdate: boolean;
  error?: string;
}

export interface FileAssociationStatus {
  platform: NodeJS.Platform;
  supported: boolean;
  associated: boolean;
}

export interface FileAssociationResult {
  ok: boolean;
  supported: boolean;
  platform: NodeJS.Platform;
  message: string;
  error?: string;
}

export interface MarkdownEditorApi {
  newWindow: () => Promise<void>;
  openDocumentDialog: () => Promise<OpenedDocument | null>;
  openDocumentDialogInNewWindow: () => Promise<boolean>;
  openDocumentPath: (filePath: string) => Promise<OpenedDocument>;
  openFolderDialog: () => Promise<OpenedFolder | null>;
  openFolderDialogInNewWindow: () => Promise<boolean>;
  readFolder: (folderPath: string) => Promise<OpenedFolder>;
  saveDocument: (payload: SaveDocumentPayload) => Promise<SavedDocument | null>;
  saveDocumentAs: (payload: SaveDocumentPayload) => Promise<SavedDocument | null>;
  saveImage: (payload: SaveImagePayload) => Promise<SavedImage>;
  chooseImageDirectory: () => Promise<string | null>;
  getPathForFile?: (file: unknown) => string;
  openExternal: (url: string) => Promise<void>;
  exportClipboardDebug: () => Promise<string | null>;
  exportAsPdf: (payload: ExportDocumentPayload) => Promise<boolean>;
  exportAsImage: (payload: ExportDocumentPayload) => Promise<boolean>;
  exportWithPandoc: (
    payload: ExportDocumentPayload,
    format: PandocExportFormat,
    options?: PandocExportOptions,
  ) => Promise<boolean>;
  getExportCapabilities: () => Promise<ExportCapabilities>;
  getPandocTemplates: () => Promise<PandocTemplateMap>;
  setPandocTemplate: (format: PandocExportFormat, templatePath: string | null) => Promise<PandocTemplateMap>;
  choosePandocTemplate: (format: PandocExportFormat) => Promise<string | null>;
  getAppInfo: () => Promise<AppInfo>;
  checkForUpdates: (includePrerelease: boolean) => Promise<UpdateCheckResult>;
  getFileAssociationStatus: () => Promise<FileAssociationStatus>;
  setFileAssociation: (enabled: boolean) => Promise<FileAssociationResult>;
  setTheme: (theme: ThemeMode) => Promise<void>;
  zoomIn: () => Promise<void>;
  zoomOut: () => Promise<void>;
  zoomReset: () => Promise<void>;
  setWindowDirty: (dirty: boolean) => Promise<void>;
  setWindowDocumentState: (state: WindowDocumentState) => Promise<void>;
  respondSaveBeforeClose: (saved: boolean) => void;
  acknowledgeExternalFileChange: (
    payload: ExternalFileChangeAck,
  ) => Promise<void>;
  onDocumentOpened: (callback: (document: OpenedDocument) => void) => () => void;
  onFolderOpened: (callback: (folder: OpenedFolder) => void) => () => void;
  onExportStatus: (callback: (status: ExportStatus) => void) => () => void;
  onRequestSaveBeforeClose: (callback: () => void) => () => void;
  onMenuAction: (callback: (action: MenuAction) => void) => () => void;
  onExternalFileChange: (callback: (event: ExternalFileChangeEvent) => void) => () => void;
  onExportPandocRequest: (
    callback: (format: PandocExportFormat, options?: PandocExportOptions) => void,
  ) => () => void;
}

export interface ExternalFileChangeEvent {
  path: string;
  kind: 'changed' | 'deleted';
  title: string;
}

export interface ExternalFileChangeAck {
  path: string;
  reloaded?: boolean;
  dismissed?: boolean;
}

/** format → absolute template path (reference-doc / --template). */
export type PandocTemplateMap = Partial<Record<PandocExportFormat, string>>;

export interface PandocExportOptions {
  /** Absolute path to a pandoc reference doc / template. Empty = no template. */
  templatePath?: string | null;
  /** When true, prompt the user to pick a template for this export. */
  chooseTemplate?: boolean;
}
