import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Page } from 'playwright-core';
import {
  buildRenderer,
  launchResourceElectron,
  readRendererResources,
  RESOURCE_MARKDOWN_PATH,
  waitForVisualReady,
} from './resource-metrics.ts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DomLayerAudit {
  mode: string;
  elements: number;
  counts: Record<string, number>;
  examples: Record<string, string[]>;
  topClasses: Array<{ name: string; count: number }>;
}

async function collectDomLayerAudit(page: Page, mode: string): Promise<DomLayerAudit> {
  return page.evaluate(({ mode: nextMode }) => {
    const counts: Record<string, number> = {
      willChange: 0,
      transform: 0,
      backdropFilter: 0,
      stickyFixed: 0,
      scrollContainer: 0,
      contain: 0,
      contentVisibility: 0,
    };
    const examples: Record<string, string[]> = {
      willChange: [],
      transform: [],
      backdropFilter: [],
    };
    const classCounts = new Map<string, number>();
    const elements = Array.from(document.querySelectorAll<HTMLElement>('*'));
    for (const element of elements) {
      const style = getComputedStyle(element);
      const willChange = style.willChange;
      if (willChange && willChange !== 'auto') {
        counts.willChange += 1;
        if (examples.willChange.length < 20) {
          examples.willChange.push(
            `${element.tagName.toLowerCase()}.${element.className}`,
          );
        }
      }
      if (style.transform && style.transform !== 'none') {
        counts.transform += 1;
        if (examples.transform.length < 20) {
          examples.transform.push(
            `${element.tagName.toLowerCase()}.${element.className}`,
          );
        }
      }
      if (style.backdropFilter && style.backdropFilter !== 'none') {
        counts.backdropFilter += 1;
        if (examples.backdropFilter.length < 20) {
          examples.backdropFilter.push(
            `${element.tagName.toLowerCase()}.${element.className}`,
          );
        }
      }
      if (style.position === 'sticky' || style.position === 'fixed') {
        counts.stickyFixed += 1;
      }
      if (
        style.overflowX === 'auto' ||
        style.overflowX === 'scroll' ||
        style.overflowY === 'auto' ||
        style.overflowY === 'scroll'
      ) {
        counts.scrollContainer += 1;
      }
      if (style.contain && style.contain !== 'none') {
        counts.contain += 1;
      }
      if (style.contentVisibility && style.contentVisibility !== 'visible') {
        counts.contentVisibility += 1;
      }
      for (const className of element.classList) {
        classCounts.set(className, (classCounts.get(className) ?? 0) + 1);
      }
    }
    return {
      mode: nextMode,
      elements: elements.length,
      counts,
      examples,
      topClasses: Array.from(classCounts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((left, right) => right.count - left.count)
        .slice(0, 30),
    };
  }, { mode });
}

interface LayerTreeSample {
  mode: string;
  count: number;
  layers: Array<{
    id: string;
    bounds: { x: number; y: number; width: number; height: number };
    backingStoreSize: { width: number; height: number };
    transform: string;
  }>;
}

async function collectLayerTree(page: Page, mode: string): Promise<LayerTreeSample> {
  const session = await page.context().newCDPSession(page);
  let layers: Array<Record<string, unknown>> = [];
  session.on('LayerTree.layerTreeDidChange', (event) => {
    const payload = event as { layers?: Array<Record<string, unknown>> };
    layers = payload.layers ?? [];
  });
  try {
    await session.send('LayerTree.enable');
    await wait(1500);
    const bounds = layers
      .map((layer) => {
        const rawBounds = layer.bounds as
          | { x?: number; y?: number; width?: number; height?: number }
          | undefined;
        const rawBacking = layer.backingStoreSize as
          | { width?: number; height?: number }
          | undefined;
        return {
          id: String(layer.layerId ?? ''),
          bounds: {
            x: Number(rawBounds?.x ?? 0),
            y: Number(rawBounds?.y ?? 0),
            width: Number(rawBounds?.width ?? 0),
            height: Number(rawBounds?.height ?? 0),
          },
          backingStoreSize: {
            width: Number(rawBacking?.width ?? 0),
            height: Number(rawBacking?.height ?? 0),
          },
          transform: String(layer.transform ?? ''),
        };
      })
      .sort((left, right) => {
        const leftArea = left.bounds.width * left.bounds.height;
        const rightArea = right.bounds.width * right.bounds.height;
        return rightArea - leftArea;
      });
    return { mode, count: bounds.length, layers: bounds.slice(0, 30) };
  } finally {
    await session.send('LayerTree.disable').catch(() => {});
    await session.detach();
  }
}

async function toggleMode(page: Page, target: 'source' | 'visual'): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }),
    );
  });
  await page.waitForFunction(
    (nextTarget) => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const input = frame?.querySelector<HTMLTextAreaElement>('.source-editor__input');
      const isSource = Boolean(frame?.classList.contains('is-source'));
      return nextTarget === 'source' ? Boolean(isSource && input) : Boolean(!isSource && !input);
    },
    target,
    { timeout: 30_000 },
  );
  await page.evaluate(() =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function main(): Promise<void> {
  const filePath = process.env.MARIVELL_RESOURCE_FILE ?? RESOURCE_MARKDOWN_PATH;
  if (!fs.existsSync(filePath)) {
    throw new Error(`resource file missing: ${filePath}`);
  }
  const source = fs.readFileSync(filePath, 'utf8');
  const outDir = path.join(os.tmpdir(), `marivell-governance-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-governance-profile-${process.pid}`);
  const port = 9880 + (process.pid % 100);
  let handle: Awaited<ReturnType<typeof launchResourceElectron>> | null = null;

  console.log(`\n## resource governance audit: ${path.basename(filePath)}`);
  console.log(`building ${outDir}`);
  await buildRenderer(outDir);
  try {
    handle = await launchResourceElectron(outDir, filePath, port, profile);
    await waitForVisualReady(
      handle.page,
      Math.min(Math.max(source.length * 0.5, 10_000), 100_000),
      60_000,
    );

    const visualDom = await collectDomLayerAudit(handle.page, 'visual');
    const visualLayers = await collectLayerTree(handle.page, 'visual');
    const resourcesVisual = await readRendererResources(handle.page);
    await toggleMode(handle.page, 'source');
    const sourceDom = await collectDomLayerAudit(handle.page, 'source');
    const sourceLayers = await collectLayerTree(handle.page, 'source');
    const resourcesSource = await readRendererResources(handle.page);
    const summarizeResources = (resources: Awaited<ReturnType<typeof readRendererResources>>) => {
      const gpu = resources.appMetrics.metrics.find((metric) => metric.type === 'GPU') ?? null;
      const renderer = resources.appMetrics.metrics.find(
        (metric) => metric.pid === resources.appMetrics.rendererProcessId,
      ) ?? null;
      return {
        gpuWorkingSetMb: gpu ? gpu.memory.workingSetSize / 1024 : null,
        rendererWorkingSetMb: renderer ? renderer.memory.workingSetSize / 1024 : null,
        worker: {
          formulaQueueDepth: resources.worker.formulaQueueDepth,
          formulaInFlightCount: resources.worker.formulaInFlightCount,
          pendingFormulaHtmlChunks: resources.worker.pendingFormulaHtmlChunks,
          formulaHtmlProcessingScheduled:
            resources.worker.formulaHtmlProcessingScheduled,
          formulaChunkPumpThrottled: resources.worker.formulaChunkPumpThrottled,
          maxFormulaQueueDepth: resources.worker.maxFormulaQueueDepth,
          maxPendingFormulaHtmlChunks: resources.worker.maxPendingFormulaHtmlChunks,
        },
      };
    };
    const report = {
      filePath,
      fileBytes: source.length,
      dom: [visualDom, sourceDom],
      layers: [visualLayers, sourceLayers],
      resources: {
        visual: summarizeResources(resourcesVisual),
        source: summarizeResources(resourcesSource),
      },
    };
    console.log('\n## RESOURCE_GOVERNANCE_AUDIT');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (handle) {
      if (process.platform !== 'win32') {
        try {
          process.kill(-handle.child.pid, 'SIGKILL');
        } catch {
          // Process group may already be gone.
        }
      }
      handle.child.kill('SIGKILL');
      await handle.browser.close().catch(() => {});
    }
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
