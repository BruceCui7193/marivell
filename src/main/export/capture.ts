import type { BrowserWindow } from 'electron';

/**
 * High-quality full-page PNG via Chrome DevTools Protocol.
 * Uses captureBeyondViewport + deviceScaleFactor for crisp long images.
 */
export async function captureFullPagePng(
  window: BrowserWindow,
  options: {
    contentWidth?: number;
    scaleFactor?: number;
    onProgress?: (message: string) => void;
  } = {},
): Promise<Buffer> {
  const contentWidth = options.contentWidth ?? 860;
  const scaleFactor = options.scaleFactor ?? 2;
  const webContents = window.webContents;

  options.onProgress?.('正在测量文档尺寸…');

  // Measure layout width/height at CSS pixels.
  const metrics = (await webContents.executeJavaScript(`
    (() => {
      const page = document.querySelector('.export-page') || document.body;
      const width = Math.max(
        page.scrollWidth || 0,
        page.getBoundingClientRect().width || 0,
        document.documentElement.scrollWidth || 0,
        ${contentWidth},
      );
      const height = Math.max(
        page.scrollHeight || 0,
        document.documentElement.scrollHeight || 0,
        document.body.scrollHeight || 0,
        1,
      );
      return {
        width: Math.ceil(width),
        height: Math.ceil(height),
      };
    })()
  `)) as { width: number; height: number };

  const cssWidth = Math.max(metrics.width, contentWidth);
  const cssHeight = Math.max(metrics.height, 1);

  // Size the window large enough that layout is stable.
  window.setContentSize(cssWidth, Math.min(cssHeight, 1600));

  await webContents.executeJavaScript(`
    document.documentElement.style.width = '${cssWidth}px';
    document.body.style.width = '${cssWidth}px';
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    window.scrollTo(0, 0);
  `);

  options.onProgress?.('正在生成高清长图…');

  let attached = false;
  try {
    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach('1.3');
      attached = true;
    }

    await webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: cssWidth,
      height: Math.min(cssHeight, 1200),
      deviceScaleFactor: scaleFactor,
      mobile: false,
      screenWidth: cssWidth,
      screenHeight: Math.min(cssHeight, 1200),
    });

    // Give layout a tick after metrics override.
    await webContents.executeJavaScript(`
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    `);

    const result = (await webContents.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
    })) as { data: string };

    if (!result?.data) {
      throw new Error('截图数据为空');
    }

    return Buffer.from(result.data, 'base64');
  } catch (error) {
    // Fallback: slice + stitch using capturePage (lower quality but works).
    options.onProgress?.('高精度截图失败，改用兼容模式…');
    return capturePageFallback(window, cssWidth, cssHeight, options.onProgress);
  } finally {
    try {
      if (webContents.debugger.isAttached()) {
        await webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
      }
    } catch {
      // ignore
    }
    if (attached && webContents.debugger.isAttached()) {
      try {
        webContents.debugger.detach();
      } catch {
        // ignore
      }
    }
  }
}

async function capturePageFallback(
  window: BrowserWindow,
  totalWidth: number,
  totalHeight: number,
  onProgress?: (message: string) => void,
): Promise<Buffer> {
  const { PNG } = await import('pngjs');
  const chunkHeight = 1600;
  const slices: Buffer[] = [];
  const chunkCount = Math.max(1, Math.ceil(totalHeight / chunkHeight));

  await window.webContents.executeJavaScript(`
    document.documentElement.style.scrollBehavior = 'auto';
    document.body.style.scrollBehavior = 'auto';
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    window.scrollTo(0, 0);
  `);

  for (let offset = 0, index = 0; offset < totalHeight; offset += chunkHeight, index += 1) {
    const currentHeight = Math.min(chunkHeight, totalHeight - offset);
    onProgress?.(`正在截取长图… (${index + 1}/${chunkCount})`);
    window.setContentSize(totalWidth, currentHeight);

    await window.webContents.executeJavaScript(`
      new Promise((resolve) => {
        document.documentElement.scrollTop = ${offset};
        document.body.scrollTop = ${offset};
        window.scrollTo(0, ${offset});
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 40)));
      })
    `);

    const image = await window.webContents.capturePage({
      x: 0,
      y: 0,
      width: totalWidth,
      height: currentHeight,
    });
    const png = image.toPNG();
    if (!png.length) {
      throw new Error('兼容模式截图失败');
    }
    slices.push(png);
  }

  const decoded = slices.map((slice) => PNG.sync.read(slice));
  const width = decoded[0]?.width ?? 0;
  const height = decoded.reduce((sum, slice) => sum + slice.height, 0);
  const output = new PNG({ width, height });
  let y = 0;
  for (const slice of decoded) {
    PNG.bitblt(slice, output, 0, 0, slice.width, slice.height, 0, y);
    y += slice.height;
  }
  return PNG.sync.write(output);
}

export async function printWindowToPdf(window: BrowserWindow): Promise<Buffer> {
  return window.webContents.printToPDF({
    printBackground: true,
    preferCSSPageSize: true,
    landscape: false,
    pageSize: 'A4',
    // Let @page CSS control margins for consistent typography.
    margins: {
      marginType: 'none',
    },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `
      <div style="width:100%;font-size:9px;color:#6b7280;padding:0 14mm;display:flex;justify-content:space-between;font-family:system-ui,sans-serif;">
        <span class="title"></span>
        <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
      </div>
    `,
  });
}
