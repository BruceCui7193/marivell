import path from 'node:path';
import { promises as fs } from 'node:fs';
import { BrowserWindow, dialog } from 'electron';
import type {
  ExportStatus,
  PandocExportFormat,
  PandocExportOptions,
  PandocTemplateMap,
} from '@shared/contracts';
import { captureFullPagePng, printWindowToPdf } from './capture';
import {
  exportWithPandoc,
  getPandocVersion,
  PANDOC_FORMATS,
  resolvePandocPath,
  type PandocFormat,
} from './pandoc';
import { buildExportDocumentHtml, createExportRenderWindow } from './render';
import {
  choosePandocTemplateFile,
  getTemplateSupport,
  loadPandocTemplates,
  resolveTemplateForExport,
  setPandocTemplate,
} from './templates';

export interface ExportDocumentPayload {
  markdown: string;
  title: string;
  /** Absolute document path, used for default save name and relative images. */
  documentPath: string | null;
}

function getDialogParent(parentWindow: BrowserWindow | null): BrowserWindow | undefined {
  if (process.platform === 'linux' || !parentWindow) {
    return undefined;
  }
  return parentWindow;
}

async function showError(
  hostWindow: BrowserWindow | null,
  title: string,
  message: string,
  detail: string,
): Promise<void> {
  const options = {
    type: 'error' as const,
    title,
    message,
    detail,
  };
  const parent = getDialogParent(hostWindow);
  if (parent) {
    await dialog.showMessageBox(parent, options);
  } else {
    await dialog.showMessageBox(options);
  }
}

async function showWarning(
  hostWindow: BrowserWindow | null,
  title: string,
  message: string,
  detail: string,
): Promise<void> {
  const options = {
    type: 'warning' as const,
    title,
    message,
    detail,
  };
  const parent = getDialogParent(hostWindow);
  if (parent) {
    await dialog.showMessageBox(parent, options);
  } else {
    await dialog.showMessageBox(options);
  }
}

async function showSave(
  hostWindow: BrowserWindow | null,
  options: Electron.SaveDialogOptions,
): Promise<Electron.SaveDialogReturnValue> {
  const parent = getDialogParent(hostWindow);
  if (parent) {
    return dialog.showSaveDialog(parent, options);
  }
  return dialog.showSaveDialog(options);
}

function sanitizeFileNameSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'document';
}

function buildDefaultName(payload: ExportDocumentPayload, extension: string): string {
  const fromPath = payload.documentPath
    ? path.basename(payload.documentPath).replace(/\.(md|markdown)$/i, '')
    : '';
  const base = sanitizeFileNameSegment(
    fromPath || payload.title.replace(/\.(md|markdown)$/i, '') || 'document',
  );
  return `${base}.${extension}`;
}

function baseDirFromPayload(payload: ExportDocumentPayload): string | null {
  if (!payload.documentPath) return null;
  return path.dirname(payload.documentPath);
}

function sendStatus(
  window: BrowserWindow | null,
  status: ExportStatus,
): void {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return;
  }
  window.webContents.send('export:status', status);
}

function finishStatus(window: BrowserWindow | null, message: string): void {
  sendStatus(window, { active: true, message });
  setTimeout(() => {
    sendStatus(window, { active: false, message: '' });
  }, 1200);
}

export async function exportDocumentAsPdf(
  hostWindow: BrowserWindow | null,
  payload: ExportDocumentPayload,
): Promise<boolean> {
  sendStatus(hostWindow, { active: true, message: '正在准备 PDF 导出…' });

  const saveResult = await showSave(hostWindow, {
    title: '导出 PDF',
    defaultPath: buildDefaultName(payload, 'pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });

  if (saveResult.canceled || !saveResult.filePath) {
    sendStatus(hostWindow, { active: false, message: '' });
    return false;
  }

  let cleanup: (() => Promise<void>) | null = null;
  try {
    sendStatus(hostWindow, { active: true, message: '正在渲染文档…' });
    const html = await buildExportDocumentHtml({
      markdown: payload.markdown,
      title: payload.title,
      baseDir: baseDirFromPayload(payload),
      mode: 'pdf',
    });

    const rendered = await createExportRenderWindow(html, { width: 920 });
    cleanup = rendered.cleanup;

    sendStatus(hostWindow, { active: true, message: '正在生成 PDF…' });
    const pdf = await printWindowToPdf(rendered.window);
    await fs.writeFile(saveResult.filePath, pdf);
    finishStatus(hostWindow, '已完成 PDF 导出');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await showError(hostWindow, '导出 PDF 失败', '导出 PDF 时出错', message);
    sendStatus(hostWindow, { active: false, message: '' });
    return false;
  } finally {
    if (cleanup) {
      await cleanup();
    }
  }
}

export async function exportDocumentAsImage(
  hostWindow: BrowserWindow | null,
  payload: ExportDocumentPayload,
): Promise<boolean> {
  sendStatus(hostWindow, { active: true, message: '正在准备图片导出…' });

  const saveResult = await showSave(hostWindow, {
    title: '导出长图',
    defaultPath: buildDefaultName(payload, 'png'),
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  });

  if (saveResult.canceled || !saveResult.filePath) {
    sendStatus(hostWindow, { active: false, message: '' });
    return false;
  }

  let cleanup: (() => Promise<void>) | null = null;
  let finished = false;
  try {
    sendStatus(hostWindow, { active: true, message: '正在渲染文档…' });
    const html = await buildExportDocumentHtml({
      markdown: payload.markdown,
      title: payload.title,
      baseDir: baseDirFromPayload(payload),
      mode: 'image',
    });

    const rendered = await createExportRenderWindow(html, { width: 900 });
    cleanup = rendered.cleanup;

    const png = await captureFullPagePng(rendered.window, {
      contentWidth: 800,
      scaleFactor: 2,
      onProgress: (message) => sendStatus(hostWindow, { active: true, message }),
    });

    await fs.writeFile(saveResult.filePath, png);
    finished = true;
    finishStatus(hostWindow, '已完成图片导出');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await showError(hostWindow, '导出图片失败', '导出图片时出错', message);
    return false;
  } finally {
    if (cleanup) {
      await cleanup().catch(() => undefined);
    }
    // Never leave the "正在生成高清长图" banner stuck if capture hangs then recovers
    // via fallback failure, or if status was mid-flight when an error fired.
    if (!finished) {
      sendStatus(hostWindow, { active: false, message: '' });
    }
  }
}

export async function exportDocumentWithPandoc(
  hostWindow: BrowserWindow | null,
  payload: ExportDocumentPayload,
  format: PandocFormat,
  options: PandocExportOptions = {},
): Promise<boolean> {
  const formatOption = PANDOC_FORMATS.find((item) => item.id === format);
  if (!formatOption) {
    return false;
  }

  const pandocPath = await resolvePandocPath();
  if (!pandocPath) {
    await showWarning(
      hostWindow,
      '未安装 Pandoc',
      '导出该格式需要安装 Pandoc',
      '请前往 https://pandoc.org/installing.html 安装 Pandoc，或设置环境变量 PANDOC_PATH 指向 pandoc 可执行文件。\n\n安装后重启本应用即可使用 Word / EPUB / LaTeX 等导出。',
    );
    return false;
  }

  // Resolve template before the save dialog so cancel is cheap.
  let templatePath: string | null = null;
  try {
    templatePath = await resolveTemplateForExport(hostWindow, format, {
      templatePath: options.templatePath,
      chooseTemplate: options.chooseTemplate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await showError(hostWindow, '模板选择失败', '无法使用自定义模板', message);
    return false;
  }

  sendStatus(hostWindow, {
    active: true,
    message: templatePath
      ? `正在通过 Pandoc 导出 ${formatOption.label}（使用自定义模板）…`
      : `正在通过 Pandoc 导出 ${formatOption.label}…`,
  });

  const saveResult = await showSave(hostWindow, {
    title: `导出 ${formatOption.label}`,
    defaultPath: buildDefaultName(payload, formatOption.extension),
    filters: [
      { name: formatOption.filterName, extensions: [formatOption.extension] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });

  if (saveResult.canceled || !saveResult.filePath) {
    sendStatus(hostWindow, { active: false, message: '' });
    return false;
  }

  try {
    await exportWithPandoc({
      markdown: payload.markdown,
      format,
      outputPath: saveResult.filePath,
      resourcePath: baseDirFromPayload(payload),
      title: payload.title.replace(/\.(md|markdown)$/i, ''),
      templatePath,
    });
    finishStatus(
      hostWindow,
      templatePath
        ? `已完成 ${formatOption.label} 导出（已套用模板）`
        : `已完成 ${formatOption.label} 导出`,
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await showError(hostWindow, 'Pandoc 导出失败', `导出 ${formatOption.label} 时出错`, message);
    sendStatus(hostWindow, { active: false, message: '' });
    return false;
  }
}

export async function getExportCapabilities(): Promise<{
  pandocAvailable: boolean;
  pandocVersion: string | null;
  formats: typeof PANDOC_FORMATS;
  templates: PandocTemplateMap;
}> {
  const pandocVersion = await getPandocVersion();
  const templates = await loadPandocTemplates();
  return {
    pandocAvailable: Boolean(pandocVersion),
    pandocVersion,
    formats: PANDOC_FORMATS,
    templates,
  };
}

export async function getPandocTemplates(): Promise<PandocTemplateMap> {
  return loadPandocTemplates();
}

export async function updatePandocTemplate(
  format: PandocExportFormat,
  templatePath: string | null,
): Promise<PandocTemplateMap> {
  return setPandocTemplate(format, templatePath);
}

export async function pickPandocTemplate(
  hostWindow: BrowserWindow | null,
  format: PandocFormat,
): Promise<string | null> {
  const support = getTemplateSupport(format);
  if (!support.flag) {
    await showWarning(
      hostWindow,
      '不支持模板',
      `${format} 格式不支持自定义模板`,
      support.hint,
    );
    return null;
  }

  const picked = await choosePandocTemplateFile(hostWindow, format);
  if (picked) {
    await setPandocTemplate(format as PandocExportFormat, picked);
  }
  return picked;
}

export { PANDOC_FORMATS, type PandocFormat, getTemplateSupport };
