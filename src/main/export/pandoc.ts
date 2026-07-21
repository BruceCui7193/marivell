import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTemplateSupport } from './templates';

export type PandocFormat =
  | 'docx'
  | 'html'
  | 'odt'
  | 'epub'
  | 'latex'
  | 'rtf'
  | 'plain'
  | 'pptx'
  | 'gfm';

export interface PandocFormatOption {
  id: PandocFormat;
  label: string;
  extension: string;
  filterName: string;
}

export const PANDOC_FORMATS: PandocFormatOption[] = [
  { id: 'docx', label: 'Word 文档 (DOCX)', extension: 'docx', filterName: 'Word 文档' },
  { id: 'html', label: 'HTML 网页', extension: 'html', filterName: 'HTML' },
  { id: 'odt', label: 'OpenDocument (ODT)', extension: 'odt', filterName: 'OpenDocument' },
  { id: 'epub', label: 'EPUB 电子书', extension: 'epub', filterName: 'EPUB' },
  { id: 'latex', label: 'LaTeX 源文件', extension: 'tex', filterName: 'LaTeX' },
  { id: 'rtf', label: 'RTF 富文本', extension: 'rtf', filterName: 'RTF' },
  { id: 'pptx', label: 'PowerPoint (PPTX)', extension: 'pptx', filterName: 'PowerPoint' },
  { id: 'plain', label: '纯文本', extension: 'txt', filterName: 'Text' },
  { id: 'gfm', label: 'GitHub Flavored Markdown', extension: 'md', filterName: 'Markdown' },
];

let cachedPandocPath: string | null | undefined;

function candidatePandocPaths(): string[] {
  const paths: string[] = [];
  if (process.env.PANDOC_PATH) {
    paths.push(process.env.PANDOC_PATH);
  }
  if (process.platform === 'win32') {
    paths.push(
      'C:\\Program Files\\Pandoc\\pandoc.exe',
      'C:\\Program Files (x86)\\Pandoc\\pandoc.exe',
    );
  } else {
    paths.push('/usr/bin/pandoc', '/usr/local/bin/pandoc', '/opt/homebrew/bin/pandoc');
  }
  return paths;
}

export async function resolvePandocPath(): Promise<string | null> {
  if (cachedPandocPath !== undefined) {
    return cachedPandocPath;
  }

  for (const candidate of candidatePandocPaths()) {
    if (candidate && existsSync(candidate)) {
      cachedPandocPath = candidate;
      return candidate;
    }
  }

  // Fall back to PATH lookup.
  const fromPath = await new Promise<string | null>((resolve) => {
    const command = process.platform === 'win32' ? 'where' : 'which';
    const child = spawn(command, ['pandoc'], { windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const first = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      resolve(first ?? null);
    });
  });

  cachedPandocPath = fromPath && existsSync(fromPath) ? fromPath : null;
  return cachedPandocPath;
}

export async function getPandocVersion(): Promise<string | null> {
  const pandoc = await resolvePandocPath();
  if (!pandoc) return null;

  return new Promise((resolve) => {
    const child = spawn(pandoc, ['--version'], { windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const firstLine = output.split(/\r?\n/)[0]?.trim() ?? null;
      resolve(firstLine);
    });
  });
}

export interface PandocExportOptions {
  markdown: string;
  format: PandocFormat;
  outputPath: string;
  /** Directory used to resolve relative resource paths (images, etc.). */
  resourcePath?: string | null;
  title?: string;
  /**
   * Absolute path to a custom template / reference document.
   * Applied as --reference-doc, --template, or --css depending on format.
   */
  templatePath?: string | null;
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });

    if (options.input !== undefined) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

export async function exportWithPandoc(options: PandocExportOptions): Promise<void> {
  const pandoc = await resolvePandocPath();
  if (!pandoc) {
    throw new Error(
      '未找到 Pandoc。请安装 Pandoc（https://pandoc.org）后重试，或设置环境变量 PANDOC_PATH。',
    );
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-editor-pandoc-'));
  const inputPath = path.join(tempDir, 'input.md');

  try {
    await fs.writeFile(inputPath, options.markdown, 'utf8');

    const args = [
      inputPath,
      '--from=markdown+tex_math_dollars+tex_math_single_backslash+pipe_tables+task_lists+strikeout+footnotes+fenced_code_attributes',
      `--to=${options.format}`,
      `--output=${options.outputPath}`,
      '--standalone',
    ];

    if (options.title) {
      args.push(`--metadata=title:${options.title}`);
    }

    if (options.resourcePath) {
      args.push(`--resource-path=${options.resourcePath}`);
    }

    // Custom template / reference document.
    if (options.templatePath && existsSync(options.templatePath)) {
      const support = getTemplateSupport(options.format);
      if (support.flag) {
        args.push(`${support.flag}=${options.templatePath}`);
      }
    }

    // Better DOCX/ODT defaults.
    if (options.format === 'docx' || options.format === 'odt') {
      args.push('--wrap=none');
    }

    if (options.format === 'html') {
      // Only force embed/mathjax when not using a full custom template that may
      // already define its own head/scripts.
      if (!options.templatePath) {
        args.push('--embed-resources', '--mathjax');
      } else {
        args.push('--embed-resources');
      }
    }

    if (options.format === 'epub') {
      args.push('--toc');
    }

    const result = await runProcess(pandoc, args, {
      cwd: options.resourcePath ?? tempDir,
    });

    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `Pandoc 退出码 ${result.code}`);
    }

    if (!existsSync(options.outputPath)) {
      throw new Error('Pandoc 未生成输出文件');
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
