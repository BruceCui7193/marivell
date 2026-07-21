import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { markdownToExportHtmlFragment } from './markdown-to-html';
import { EXPORT_PAGE_CSS } from './styles';

export type ExportRenderMode = 'pdf' | 'image';

export interface ExportRenderInput {
  markdown: string;
  title: string;
  baseDir: string | null;
  mode: ExportRenderMode;
}

async function readKatexCss(): Promise<string> {
  const candidateDirectories = [
    path.join(app.getAppPath(), 'node_modules', 'katex', 'dist'),
    path.join(process.cwd(), 'node_modules', 'katex', 'dist'),
    path.join(path.dirname(app.getPath('exe')), 'resources', 'app.asar.unpacked', 'node_modules', 'katex', 'dist'),
    path.join(path.dirname(app.getPath('exe')), 'resources', 'app.asar', 'node_modules', 'katex', 'dist'),
    path.join(path.dirname(app.getPath('exe')), 'resources', 'app', 'node_modules', 'katex', 'dist'),
  ];

  try {
    const katexDirectory = candidateDirectories.find((directory) =>
      existsSync(path.join(directory, 'katex.min.css')),
    );
    if (!katexDirectory) return '';

    const css = await fs.readFile(path.join(katexDirectory, 'katex.min.css'), 'utf8');
    const fontsBaseUrl = `${pathToFileURL(path.join(katexDirectory, 'fonts')).toString()}/`;
    return css
      .replace(/url\((['"]?)(?:\.\.\/)?fonts\//g, `url($1${fontsBaseUrl}`)
      .replace(/src:\s*local\('Arial'\);/g, '');
  } catch {
    return '';
  }
}

function resolveMermaidModuleUrl(): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
    path.join(process.cwd(), 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
    path.join(app.getAppPath(), 'node_modules', 'mermaid', 'dist', 'mermaid.esm.min.mjs'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return pathToFileURL(candidate).toString();
    }
  }
  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function buildExportDocumentHtml(input: ExportRenderInput): Promise<string> {
  const katexCss = await readKatexCss();
  const body = markdownToExportHtmlFragment({
    markdown: input.markdown,
    baseDir: input.baseDir,
    title: input.title,
  });
  const mermaidUrl = resolveMermaidModuleUrl();
  const bodyClass = input.mode === 'image' ? 'is-image-export' : 'is-pdf-export';

  // Prefer classic mermaid.min.js when available; otherwise inject a small
  // dynamic import bootstrap for the ESM build.
  const mermaidBootstrap = mermaidUrl
    ? mermaidUrl.endsWith('.mjs')
      ? `
      <script type="module">
        import mermaid from ${JSON.stringify(mermaidUrl)};
        window.__mermaidReady = (async () => {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'loose',
            theme: 'base',
            fontFamily: 'inherit',
          });
          const nodes = document.querySelectorAll('pre.mermaid');
          if (nodes.length) {
            await mermaid.run({ nodes });
          }
        })().then(() => { window.__exportMermaidDone = true; })
          .catch((error) => {
            console.error(error);
            window.__exportMermaidDone = true;
          });
      </script>`
      : `
      <script src="${mermaidUrl}"></script>
      <script>
        window.__mermaidReady = (async () => {
          if (!window.mermaid) return;
          window.mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'loose',
            theme: 'base',
            fontFamily: 'inherit',
          });
          const nodes = document.querySelectorAll('pre.mermaid');
          if (nodes.length) {
            await window.mermaid.run({ nodes });
          }
        })().then(() => { window.__exportMermaidDone = true; })
          .catch((error) => {
            console.error(error);
            window.__exportMermaidDone = true;
          });
      </script>`
    : `<script>window.__exportMermaidDone = true;</script>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(input.title)}</title>
    <style>${katexCss}</style>
    <style>${EXPORT_PAGE_CSS}</style>
  </head>
  <body class="${bodyClass}">
    <div class="export-page">
      <main class="export-document">
        ${body}
      </main>
    </div>
    ${mermaidBootstrap}
  </body>
</html>`;
}

export async function createExportRenderWindow(
  html: string,
  options: { width?: number } = {},
): Promise<{ window: BrowserWindow; cleanup: () => Promise<void> }> {
  const exportDirectory = await fs.mkdtemp(path.join(app.getPath('temp'), 'markdown-editor-export-'));
  const exportFilePath = path.join(exportDirectory, 'export.html');
  await fs.writeFile(exportFilePath, html, 'utf8');

  const exportWindow = new BrowserWindow({
    width: options.width ?? 920,
    height: 1000,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      sandbox: false,
      // Needed so file:// pages can load mermaid / katex fonts from node_modules.
      webSecurity: false,
    },
  });

  await exportWindow.loadFile(exportFilePath);

  await exportWindow.webContents.executeJavaScript(`
    (async () => {
      const images = Array.from(document.images || []);
      await Promise.all(images.map((image) => {
        if (image.complete) return Promise.resolve();
        return new Promise((resolve) => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
        });
      }));

      if (document.fonts?.ready) {
        await document.fonts.ready;
      }

      // Wait for mermaid (if any) with a hard timeout so export never hangs.
      const mermaidWait = new Promise((resolve) => {
        if (window.__exportMermaidDone) {
          resolve();
          return;
        }
        const started = Date.now();
        const timer = setInterval(() => {
          if (window.__exportMermaidDone || Date.now() - started > 12000) {
            clearInterval(timer);
            resolve();
          }
        }, 40);
      });
      await mermaidWait;

      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // Extra paint for SVG layout.
      await new Promise((resolve) => setTimeout(resolve, 80));
    })()
  `);

  const cleanup = async () => {
    if (!exportWindow.isDestroyed()) {
      exportWindow.close();
    }
    await fs.rm(exportDirectory, { recursive: true, force: true }).catch(() => undefined);
  };

  exportWindow.on('closed', () => {
    void fs.rm(exportDirectory, { recursive: true, force: true });
  });

  return { window: exportWindow, cleanup };
}
