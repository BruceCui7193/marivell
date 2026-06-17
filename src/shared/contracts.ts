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
  | 'toggle-sidebar';

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

export interface SaveImagePayload {
  base64: string;
  suggestedName: string;
  currentPath: string | null;
}

export interface SavedImage {
  markdownPath: string;
  absolutePath?: string;
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
  openExternal: (url: string) => Promise<void>;
  exportClipboardDebug: () => Promise<string | null>;
  setTheme: (theme: ThemeMode) => Promise<void>;
  setWindowDirty: (dirty: boolean) => Promise<void>;
  setWindowDocumentState: (state: WindowDocumentState) => Promise<void>;
  respondSaveBeforeClose: (saved: boolean) => void;
  onDocumentOpened: (callback: (document: OpenedDocument) => void) => () => void;
  onFolderOpened: (callback: (folder: OpenedFolder) => void) => () => void;
  onExportStatus: (callback: (status: ExportStatus) => void) => () => void;
  onRequestSaveBeforeClose: (callback: () => void) => () => void;
  onMenuAction: (callback: (action: MenuAction) => void) => () => void;
  onExternalFileChange: (callback: (event: ExternalFileChangeEvent) => void) => () => void;
}

export interface ExternalFileChangeEvent {
  path: string;
  kind: 'changed' | 'deleted';
  title: string;
}
