import { Suspense, lazy, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExportStatus,
  OpenedFolder,
  MenuAction,
  OpenedDocument,
  SavedDocument,
  ThemeMode,
} from '@shared/contracts';
import { type GlassEffect, type ThemePalette, isGlassEffect, isThemePalette } from './theme';
import AppDialog, { type AppDialogOptions } from './components/AppDialog';
import SettingsDialog from './components/SettingsDialog';
import { translate, useAppLanguage } from './i18n';
import { applyLiquidGlassConfig, setLiquidGlassEnabled } from './effects/liquid-glass';
import {
  DEFAULT_FROSTED_GLASS,
  DEFAULT_GLASS_CUSTOMIZATION,
  DEFAULT_LIQUID_GLASS,
  loadCustomColors,
  loadFrostedGlass,
  loadGlassCustomization,
  loadLiquidGlass,
  saveCustomColors,
  saveFrostedGlass,
  saveGlassCustomization,
  saveLiquidGlass,
  type CustomColorSettings,
  type FrostedGlassSettings,
  type GlassCustomizationSettings,
  type LiquidGlassSettings,
} from './settings';

const EditorShell = lazy(() => import('./components/EditorShell'));

export interface DocumentStats {
  words: number;
  characters: number;
  lines: number;
}

export interface EditorDocumentState {
  path: string | null;
  title: string;
  markdown: string;
  savedMarkdown: string;
  dirty: boolean;
  lastSavedAt: number | null;
  stats: DocumentStats;
}

const EMPTY_STATS: DocumentStats = {
  words: 0,
  characters: 0,
  lines: 1,
};

function areStatsEqual(left: DocumentStats, right: DocumentStats): boolean {
  return (
    left.words === right.words &&
    left.characters === right.characters &&
    left.lines === right.lines
  );
}

function createUntitledDocument(): EditorDocumentState {
  return {
    path: null,
    title: translate('untitled'),
    markdown: '',
    savedMarkdown: '',
    dirty: false,
    lastSavedAt: null,
    stats: EMPTY_STATS,
  };
}

function resolveTheme(theme: ThemeMode): 'light' | 'dark' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  return theme;
}

function cycleTheme(theme: ThemeMode): ThemeMode {
  if (theme === 'system') {
    return 'light';
  }

  if (theme === 'light') {
    return 'dark';
  }

  return 'system';
}

export default function App() {
  const [editorShellEnabled, setEditorShellEnabled] = useState(false);
  const [exportStatus, setExportStatus] = useState<ExportStatus | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const persisted = window.localStorage.getItem('markdown-editor-theme');
    if (persisted === 'light' || persisted === 'dark' || persisted === 'system') {
      return persisted;
    }

    return 'system';
  });
  const [editorDocument, setEditorDocument] = useState<EditorDocumentState>(createUntitledDocument);
  const [currentFolder, setCurrentFolder] = useState<OpenedFolder | null>(null);
  const [discardConfirm, setDiscardConfirm] = useState<AppDialogOptions | null>(null);
  const discardConfirmRef = useRef<AppDialogOptions | null>(null);
  const [, setMessage] = useState(translate('ready'));
  const [themePalette, setThemePalette] = useState<ThemePalette>(() => {
    const persisted = window.localStorage.getItem('markdown-editor-theme-palette');
    return isThemePalette(persisted) ? persisted : 'natural';
  });
  const [glassEffect, setGlassEffect] = useState<GlassEffect>(() => {
    const persisted = window.localStorage.getItem('markdown-editor-glass-effect');
    return isGlassEffect(persisted) ? persisted : 'frosted';
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [customColors, setCustomColors] = useState<CustomColorSettings>(loadCustomColors);
  const [customColorsEnabled, setCustomColorsEnabled] = useState(
    () => window.localStorage.getItem('markdown-editor-custom-colors') !== null,
  );
  const [frostedGlass, setFrostedGlass] = useState<FrostedGlassSettings>(loadFrostedGlass);
  const [liquidGlass, setLiquidGlass] = useState<LiquidGlassSettings>(loadLiquidGlass);
  const [glassCustomization, setGlassCustomization] = useState<GlassCustomizationSettings>(
    loadGlassCustomization,
  );
  const documentRef = useRef(editorDocument);
  useAppLanguage();

  const resolvedTheme = useMemo(() => resolveTheme(theme), [theme]);

  useEffect(() => {
    documentRef.current = editorDocument;
  }, [editorDocument]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setEditorShellEnabled(true);
    });

    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => {
      if (theme === 'system') {
        document.documentElement.dataset.theme = resolveTheme(theme);
      }
    };

    mediaQuery.addEventListener('change', listener);
    return () => mediaQuery.removeEventListener('change', listener);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    window.localStorage.setItem('markdown-editor-theme', theme);
    void window.markdownEditor.setTheme(theme);
  }, [resolvedTheme, theme]);

  useEffect(() => {
    document.documentElement.dataset.colorScheme = themePalette;
    window.localStorage.setItem('markdown-editor-theme-palette', themePalette);
  }, [themePalette]);

  useEffect(() => {
    document.documentElement.dataset.glassEffect = glassEffect;
    window.localStorage.setItem('markdown-editor-glass-effect', glassEffect);
  }, [glassEffect]);

  useEffect(() => {
    saveCustomColors(customColors);
    if (!customColorsEnabled) {
      return;
    }
    const style = document.documentElement.style;
    style.setProperty('--ui-accent', customColors.accent);
    style.setProperty('--ui-bg', customColors.background);
    style.setProperty('--ui-bg-strong', customColors.editorBackground);
    style.setProperty('--ui-border', customColors.border);
    style.setProperty('--ui-text', customColors.text);
    style.setProperty('--ui-editor-bg', customColors.editorBackground);
    style.setProperty(
      '--ui-accent-soft',
      `color-mix(in srgb, ${customColors.accent} 14%, transparent)`,
    );
  }, [customColors, customColorsEnabled]);

  useEffect(() => {
    saveFrostedGlass(frostedGlass);
    const style = document.documentElement.style;
    if (glassCustomization.frostedEnabled) {
      style.setProperty(
        '--glass-backdrop',
        `blur(${frostedGlass.blur}px) saturate(${frostedGlass.saturation}%) brightness(${frostedGlass.brightness}%)`,
      );
      style.setProperty(
        '--glass-fill',
        `color-mix(in srgb, var(--ui-bg-strong) ${Math.round(frostedGlass.fillOpacity * 100)}%, transparent)`,
      );
    } else {
      style.removeProperty('--glass-backdrop');
      style.removeProperty('--glass-fill');
    }
  }, [frostedGlass, glassCustomization.frostedEnabled]);

  useEffect(() => {
    saveLiquidGlass(liquidGlass);
    applyLiquidGlassConfig(
      glassCustomization.liquidEnabled ? liquidGlass : DEFAULT_LIQUID_GLASS,
    );
  }, [glassCustomization.liquidEnabled, liquidGlass]);

  useEffect(() => {
    saveGlassCustomization(glassCustomization);
  }, [glassCustomization]);

  useEffect(() => {
    setLiquidGlassEnabled(glassEffect === 'liquid');
    return () => setLiquidGlassEnabled(false);
  }, [glassEffect]);

  useEffect(() => {
    void window.markdownEditor.setWindowDirty(editorDocument.dirty);
  }, [editorDocument.dirty]);

  useEffect(() => {
    void window.markdownEditor.setWindowDocumentState({
      path: editorDocument.path,
      markdown: editorDocument.markdown,
      dirty: editorDocument.dirty,
    });
  }, [editorDocument.dirty, editorDocument.markdown, editorDocument.path]);

  const refreshFolderForDocument = useCallback(async (filePath: string | null): Promise<void> => {
    const folderPath = getDirectoryPath(filePath);
    if (!folderPath) {
      setCurrentFolder(null);
      return;
    }

    try {
      const folder = await window.markdownEditor.readFolder(folderPath);
      setCurrentFolder(folder);
    } catch {
      setCurrentFolder(null);
      setMessage(translate('readingFolderFailed'));
    }
  }, []);

  const applyOpenedDocument = useCallback((
    openedDocument: OpenedDocument,
    options?: { urgent?: boolean },
  ): void => {
    const apply = () => {
      setEditorDocument((current) => ({
        ...current,
        path: openedDocument.path,
        title: openedDocument.title,
        markdown: openedDocument.markdown,
        savedMarkdown: openedDocument.markdown,
        dirty: false,
        lastSavedAt: Date.now(),
      }));
      setMessage(translate('openedDocument', { title: openedDocument.title }));
    };

    // External reloads must not sit in a transition — delayed paint makes it
    // easy for the editor to stay non-editable / unfocused after confirm.
    if (options?.urgent) {
      apply();
    } else {
      startTransition(apply);
    }
    void refreshFolderForDocument(openedDocument.path);
  }, [refreshFolderForDocument]);

  const applySavedDocument = useCallback((savedDocument: SavedDocument): void => {
    startTransition(() => {
      setEditorDocument((current) => ({
        ...current,
        path: savedDocument.path,
        title: savedDocument.title,
        markdown: savedDocument.markdown,
        savedMarkdown: savedDocument.markdown,
        dirty: false,
        lastSavedAt: Date.now(),
      }));
      setMessage(translate('savedTo', { title: savedDocument.title }));
    });
    void refreshFolderForDocument(savedDocument.path);
  }, [refreshFolderForDocument]);

  const confirmDiscardChanges = useCallback((): Promise<boolean> => {
    if (!documentRef.current.dirty) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      const dialog: AppDialogOptions = {
        title: translate('unsavedChanges'),
        message: translate('unsavedMessage'),
        detail: translate('discardPrompt'),
        buttons: [
          { value: 'discard', label: translate('discardChanges'), variant: 'danger' },
          { value: 'cancel', label: translate('cancel') },
        ],
        cancelValue: 'cancel',
        onResolve: (value) => resolve(value === 'discard'),
      };
      discardConfirmRef.current = dialog;
      setDiscardConfirm(dialog);
    });
  }, []);

  const resolveDiscardConfirm = useCallback((value: string) => {
    const dialog = discardConfirmRef.current;
    discardConfirmRef.current = null;
    setDiscardConfirm(null);
    dialog?.onResolve(value);
  }, []);

  const openDocument = useCallback(async (): Promise<void> => {
    const opened = await window.markdownEditor.openDocumentDialogInNewWindow();
    if (opened) {
      setMessage(translate('openedNewWindowFile'));
    }
  }, []);

  const openDocumentPath = useCallback(async (filePath: string): Promise<void> => {
    if (!(await confirmDiscardChanges())) {
      return;
    }

    const document = await window.markdownEditor.openDocumentPath(filePath);
    applyOpenedDocument(document);
  }, [applyOpenedDocument, confirmDiscardChanges]);

  /** Force-reload from disk without a second discard confirm (caller already asked). */
  const reloadDocumentPath = useCallback(async (filePath: string): Promise<void> => {
    const document = await window.markdownEditor.openDocumentPath(filePath);
    applyOpenedDocument(document, { urgent: true });
  }, [applyOpenedDocument]);

  const openFolder = useCallback(async (): Promise<void> => {
    try {
      const opened = await window.markdownEditor.openFolderDialogInNewWindow();
      if (opened) {
        setMessage(translate('openedNewWindowFolder'));
      }
    } catch {
      setMessage(translate('openFolderFailed'));
    }
  }, []);

  const saveDocument = useCallback(async (
    saveAs = false,
    overrideMarkdown?: string,
    overrideStats?: DocumentStats,
  ): Promise<boolean> => {
    const currentDocument = documentRef.current;
    const markdown = overrideMarkdown ?? currentDocument.markdown;

    if (overrideMarkdown !== undefined && overrideStats) {
      setEditorDocument((current) => ({
        ...current,
        markdown: overrideMarkdown,
        dirty: overrideMarkdown !== current.savedMarkdown,
        stats: overrideStats,
      }));
    }

    const payload = {
      markdown,
      currentPath: currentDocument.path,
    };

    const result = saveAs
      ? await window.markdownEditor.saveDocumentAs(payload)
      : await window.markdownEditor.saveDocument(payload);

    if (!result) {
      setMessage(translate('saveCancelled'));
      return false;
    }

    applySavedDocument(result);
    return true;
  }, [applySavedDocument]);

  const createNewDocument = useCallback(async (): Promise<void> => {
    await window.markdownEditor.newWindow();
    setMessage(translate('newWindowOpened'));
  }, []);

  const handleMenuAction = useCallback(async (action: MenuAction): Promise<void> => {
    if (action === 'new-document') {
      await createNewDocument();
      return;
    }

    if (action === 'open-document') {
      await openDocument();
      return;
    }

    if (action === 'open-folder') {
      await openFolder();
      return;
    }

    if (
      action === 'save-document' ||
      action === 'save-document-as' ||
      action === 'toggle-source-mode' ||
      action === 'toggle-toolbar' ||
      action === 'toggle-sidebar' ||
      action === 'export-pdf' ||
      action === 'export-image' ||
      action === 'export-pandoc'
    ) {
      window.dispatchEvent(
        new CustomEvent<MenuAction>('markdown-editor:menu-action', {
          detail: action,
        }),
      );
      return;
    }

    setTheme((current) => cycleTheme(current));
  }, [createNewDocument, openDocument, openFolder, saveDocument]);

  const handleDocumentChange = useCallback((markdown: string, stats: DocumentStats) => {
    setEditorDocument((current) => {
      const nextDirty = markdown !== current.savedMarkdown;
      if (
        current.markdown === markdown &&
        current.dirty === nextDirty &&
        areStatsEqual(current.stats, stats)
      ) {
        return current;
      }

      return {
        ...current,
        markdown,
        dirty: nextDirty,
        stats,
      };
    });
  }, []);

  const handleDocumentMetaChange = useCallback((dirty: boolean) => {
    setEditorDocument((current) => {
      if (current.dirty === dirty) {
        return current;
      }

      return {
        ...current,
        dirty,
      };
    });
  }, []);

  const handleSaveDocument = useCallback(
    (markdown?: string, stats?: DocumentStats) => saveDocument(false, markdown, stats),
    [saveDocument],
  );

  const saveDocumentAs = useCallback(async (
    overrideMarkdown?: string,
    overrideStats?: DocumentStats,
  ): Promise<SavedDocument | null> => {
    const currentDocument = documentRef.current;
    const markdown = overrideMarkdown ?? currentDocument.markdown;

    if (overrideMarkdown !== undefined && overrideStats) {
      setEditorDocument((current) => ({
        ...current,
        markdown: overrideMarkdown,
        dirty: overrideMarkdown !== current.savedMarkdown,
        stats: overrideStats,
      }));
    }

    const result = await window.markdownEditor.saveDocumentAs({
      markdown,
      currentPath: currentDocument.path,
    });

    if (!result) {
      setMessage(translate('saveCancelled'));
      return null;
    }

    documentRef.current = {
      ...currentDocument,
      path: result.path,
      title: result.title,
      markdown: result.markdown,
      savedMarkdown: result.markdown,
      dirty: false,
      lastSavedAt: Date.now(),
    };
    applySavedDocument(result);
    return result;
  }, [applySavedDocument]);

  const handleSaveDocumentAs = useCallback(
    (markdown?: string, stats?: DocumentStats) => saveDocumentAs(markdown, stats),
    [saveDocumentAs],
  );

  useEffect(() => {
    const offDocumentOpened = window.markdownEditor.onDocumentOpened((openedDocument) => {
      void (async () => {
        if (!(await confirmDiscardChanges())) {
          return;
        }

        applyOpenedDocument(openedDocument);
      })();
    });
    const offFolderOpened = window.markdownEditor.onFolderOpened((openedFolder) => {
      setCurrentFolder(openedFolder);
      setMessage(translate('folderOpened', { path: openedFolder.path }));
    });
    const offExportStatus = window.markdownEditor.onExportStatus((status) => {
      setExportStatus(status.active ? status : null);
    });
    const offMenuAction = window.markdownEditor.onMenuAction((action) => {
      void handleMenuAction(action);
    });

    return () => {
      offDocumentOpened();
      offFolderOpened();
      offExportStatus();
      offMenuAction();
    };
  }, [applyOpenedDocument, confirmDiscardChanges, handleMenuAction]);

  if (!editorShellEnabled) {
    return <div className="app-booting">{translate('loadingEditor')}</div>;
  }

  return (
    <>
      <Suspense fallback={<div className="app-booting">{translate('loadingEditor')}</div>}>
        <EditorShell
          document={editorDocument}
          folder={currentFolder}
          onCreateDocument={createNewDocument}
          onDocumentChange={handleDocumentChange}
          onDocumentMetaChange={handleDocumentMetaChange}
          onOpenDocumentPath={openDocumentPath}
          onReloadDocumentPath={reloadDocumentPath}
          onOpenFolder={openFolder}
          onOpenDocument={openDocument}
          onSaveDocument={handleSaveDocument}
          onSaveDocumentAs={handleSaveDocumentAs}
          resolvedTheme={resolvedTheme}
          theme={theme}
          glassEffect={glassEffect}
          onSetTheme={setTheme}
          onSetThemePalette={setThemePalette}
          onSetGlassEffect={setGlassEffect}
          onOpenSettings={() => setSettingsOpen(true)}
          themePalette={themePalette}
        />
      </Suspense>
      {settingsOpen ? (
        <SettingsDialog
          customColors={customColors}
          frostedGlass={frostedGlass}
          glassCustomization={glassCustomization}
          glassEffect={glassEffect}
          liquidGlass={liquidGlass}
          onClose={() => setSettingsOpen(false)}
          onSetCustomColors={(colors) => {
            setCustomColorsEnabled(true);
            setCustomColors(colors);
          }}
          onSetFrostedGlass={setFrostedGlass}
          onSetGlassCustomization={setGlassCustomization}
          onSetGlassEffect={setGlassEffect}
          onSetLiquidGlass={setLiquidGlass}
          onSetTheme={setTheme}
          onSetThemePalette={setThemePalette}
          theme={theme}
          themePalette={themePalette}
        />
      ) : null}
      {discardConfirm ? (
        <AppDialog
          buttons={discardConfirm.buttons}
          cancelValue={discardConfirm.cancelValue}
          detail={discardConfirm.detail}
          message={discardConfirm.message}
          onResolve={resolveDiscardConfirm}
          title={discardConfirm.title}
        />
      ) : null}
      {exportStatus ? <div className="app-exporting">{exportStatus.message}</div> : null}
    </>
  );
}

function getDirectoryPath(filePath: string | null): string | null {
  if (!filePath) {
    return null;
  }

  const normalized = filePath.replace(/\\/g, '/');
  const separatorIndex = normalized.lastIndexOf('/');
  if (separatorIndex === -1) {
    return null;
  }

  return filePath.slice(0, separatorIndex);
}
