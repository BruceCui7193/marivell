import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import type { PandocExportFormat, PandocTemplateMap } from '@shared/contracts';
import type { PandocFormat } from './pandoc';

export type TemplateKind = 'reference-doc' | 'template' | 'css' | 'none';

export interface TemplateSupport {
  kind: TemplateKind;
  /** File extensions accepted by the picker (without dot). */
  extensions: string[];
  /** Short help shown in dialogs. */
  hint: string;
  /** Pandoc CLI flag to pass the template path. */
  flag: '--reference-doc' | '--template' | '--css' | null;
}

/** Which Pandoc flag each format uses for “custom template”. */
export function getTemplateSupport(format: PandocFormat): TemplateSupport {
  switch (format) {
    case 'docx':
      return {
        kind: 'reference-doc',
        extensions: ['docx'],
        hint: '使用 Word 参考文档（--reference-doc）。可用 pandoc -o custom-reference.docx --print-default-data-file reference.docx 生成默认模板再改样式。',
        flag: '--reference-doc',
      };
    case 'odt':
      return {
        kind: 'reference-doc',
        extensions: ['odt'],
        hint: '使用 ODT 参考文档（--reference-doc）。',
        flag: '--reference-doc',
      };
    case 'pptx':
      return {
        kind: 'reference-doc',
        extensions: ['pptx'],
        hint: '使用 PowerPoint 参考文档（--reference-doc）。',
        flag: '--reference-doc',
      };
    case 'html':
      return {
        kind: 'template',
        extensions: ['html', 'htm'],
        hint: '使用 HTML 模板（--template）。可用 pandoc -D html > template.html 导出默认模板。',
        flag: '--template',
      };
    case 'latex':
      return {
        kind: 'template',
        extensions: ['tex', 'latex'],
        hint: '使用 LaTeX 模板（--template）。可用 pandoc -D latex > template.tex 导出默认模板。',
        flag: '--template',
      };
    case 'epub':
      return {
        kind: 'css',
        extensions: ['css'],
        hint: '使用 EPUB 样式表（--css）。',
        flag: '--css',
      };
    case 'rtf':
    case 'plain':
    case 'gfm':
    default:
      return {
        kind: 'none',
        extensions: [],
        hint: '该格式不支持自定义模板。',
        flag: null,
      };
  }
}

function templatesStorePath(): string {
  return path.join(app.getPath('userData'), 'pandoc-templates.json');
}

export async function loadPandocTemplates(): Promise<PandocTemplateMap> {
  try {
    const raw = await fs.readFile(templatesStorePath(), 'utf8');
    const parsed = JSON.parse(raw) as PandocTemplateMap;
    const cleaned: PandocTemplateMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value && existsSync(value)) {
        cleaned[key as PandocExportFormat] = value;
      }
    }
    return cleaned;
  } catch {
    return {};
  }
}

export async function savePandocTemplates(map: PandocTemplateMap): Promise<void> {
  await fs.mkdir(path.dirname(templatesStorePath()), { recursive: true });
  await fs.writeFile(templatesStorePath(), JSON.stringify(map, null, 2), 'utf8');
}

export async function setPandocTemplate(
  format: PandocExportFormat,
  templatePath: string | null,
): Promise<PandocTemplateMap> {
  const current = await loadPandocTemplates();
  if (!templatePath) {
    delete current[format];
  } else {
    current[format] = templatePath;
  }
  await savePandocTemplates(current);
  return current;
}

export async function choosePandocTemplateFile(
  hostWindow: BrowserWindow | null,
  format: PandocFormat,
): Promise<string | null> {
  const support = getTemplateSupport(format);
  if (!support.flag) {
    return null;
  }

  const parent =
    process.platform === 'linux' || !hostWindow ? undefined : hostWindow;
  const result = parent
    ? await dialog.showOpenDialog(parent, {
        title: `选择 ${format.toUpperCase()} 模板`,
        properties: ['openFile'],
        filters: [
          {
            name: '模板文件',
            extensions: support.extensions,
          },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
    : await dialog.showOpenDialog({
        title: `选择 ${format.toUpperCase()} 模板`,
        properties: ['openFile'],
        filters: [
          {
            name: '模板文件',
            extensions: support.extensions,
          },
          { name: '所有文件', extensions: ['*'] },
        ],
      });

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  return result.filePaths[0];
}

/**
 * Ask how to apply a template for this export.
 * Returns the template path to use, or null for no template.
 */
export async function resolveTemplateForExport(
  hostWindow: BrowserWindow | null,
  format: PandocFormat,
  options: {
    templatePath?: string | null;
    chooseTemplate?: boolean;
  } = {},
): Promise<string | null> {
  const support = getTemplateSupport(format);
  if (!support.flag) {
    return null;
  }

  // Explicit path from caller wins.
  if (options.templatePath) {
    return existsSync(options.templatePath) ? options.templatePath : null;
  }

  if (options.chooseTemplate) {
    return choosePandocTemplateFile(hostWindow, format);
  }

  const saved = await loadPandocTemplates();
  const savedPath = saved[format as PandocExportFormat];
  if (savedPath && existsSync(savedPath)) {
    // Offer to use saved template, pick another, or skip.
    const parent =
      process.platform === 'linux' || !hostWindow ? undefined : hostWindow;
    const boxOptions = {
      type: 'question' as const,
      buttons: ['使用已保存模板', '选择其他模板…', '不使用模板'],
      defaultId: 0,
      cancelId: 2,
      title: 'Pandoc 模板',
      message: `是否使用已保存的 ${format.toUpperCase()} 模板？`,
      detail: `${savedPath}\n\n${support.hint}`,
    };
    const result = parent
      ? await dialog.showMessageBox(parent, boxOptions)
      : await dialog.showMessageBox(boxOptions);

    if (result.response === 0) {
      return savedPath;
    }
    if (result.response === 1) {
      const picked = await choosePandocTemplateFile(hostWindow, format);
      if (picked) {
        await setPandocTemplate(format as PandocExportFormat, picked);
      }
      return picked;
    }
    return null;
  }

  // No saved template: optional quick prompt (don't force every time).
  // Skip silent for plain exports — user can set template via menu.
  return null;
}

export function buildPandocTemplateArgs(
  format: PandocFormat,
  templatePath: string | null | undefined,
): string[] {
  if (!templatePath || !existsSync(templatePath)) {
    return [];
  }
  const support = getTemplateSupport(format);
  if (!support.flag) {
    return [];
  }
  return [`${support.flag}=${templatePath}`];
}
