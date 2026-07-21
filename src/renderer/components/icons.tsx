import { useEffect, useState, type ReactElement, type SVGProps } from 'react';

type IconName =
  | 'menu'
  | 'newWindow'
  | 'open'
  | 'folder'
  | 'save'
  | 'saveAs'
  | 'search'
  | 'sidebar'
  | 'heading1'
  | 'heading2'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'link'
  | 'quote'
  | 'bullet'
  | 'ordered'
  | 'task'
  | 'table'
  | 'rowAddBefore'
  | 'rowAddAfter'
  | 'rowDelete'
  | 'columnAddBefore'
  | 'columnAddAfter'
  | 'columnDelete'
  | 'tableDelete'
  | 'code'
  | 'math'
  | 'diagram'
  | 'image'
  | 'footnote'
  | 'source'
  | 'appearance'
  | 'sun'
  | 'moon'
  | 'autoTheme'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll';

const iconPaths: Record<IconName, ReactElement> = {
  menu: (
    <path
      d="M4 7h16M4 12h16M4 17h16"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.8"
    />
  ),
  newWindow: (
    <>
      <path d="M5 5h9v9H5z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M14 10h5v9h-9v-5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </>
  ),
  open: (
    <path
      d="M4 18V7h5l2 2h9v9zM12 12l3-3 3 3"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    />
  ),
  folder: (
    <path
      d="M4 18V7h5l2 2h9v9z"
      fill="none"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="1.8"
    />
  ),
  save: (
    <path
      d="M5 5h11l3 3v11H5zM8 5v5h7V5M8 19v-5h8v5"
      fill="none"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="1.8"
    />
  ),
  sidebar: (
    <path
      d="M4 6h16v12H4zM9 6v12"
      fill="none"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="1.8"
    />
  ),
  saveAs: (
    <>
      <path
        d="M5 5h11l3 3v11H5zM8 5v5h7V5M8 19v-5h8v5"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path d="M12 12h6M15 9v6" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M15.2 15.2L19 19"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </>
  ),
  heading1: (
    <path
      d="M5 6v12M12 6v12M5 12h7M17 10l2-2v10"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    />
  ),
  heading2: (
    <path
      d="M5 6v12M12 6v12M5 12h7M16.5 10c.5-1 1.2-2 2.5-2 1.1 0 2 .8 2 1.9 0 1.1-.7 1.8-1.6 2.4L17 14h4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
    />
  ),
  bold: <path d="M8 6h5a3 3 0 010 6H8zm0 6h6a3 3 0 010 6H8z" fill="none" stroke="currentColor" strokeWidth="1.8" />,
  italic: <path d="M13 5h6M5 19h6M14 5L10 19" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />,
  underline: <path d="M7 5v7a5 5 0 0010 0V5M5 19h14" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />,
  strike: <path d="M6 12h12M9 7.5c.7-1 1.8-1.5 3-1.5 2.3 0 4 1.2 4 3 0 3-8 1.5-8 5 0 1.5 1.5 3 4 3 1.7 0 3-.5 4-1.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />,
  link: <path d="M10 14l4-4M8.5 15.5l-2 2a3 3 0 104.2 4.2l2-2M15.5 8.5l2-2A3 3 0 1021.7 11l-2 2" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />,
  quote: <path d="M7 8h4v5H7zM13 8h4v5h-4zM9 13v3a2 2 0 01-2 2M15 13v3a2 2 0 01-2 2" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />,
  bullet: <path d="M6 8h.01M6 12h.01M6 16h.01M10 8h8M10 12h8M10 16h8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />,
  ordered: <path d="M5.5 8h1v2h-1M5 16h2l-2 2h2M10 8h8M10 12h8M10 16h8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />,
  task: <path d="M5 7h3v3H5zM5 14h3v3H5zM10 8h9M10 15h9M6 15.5l.8.8L8 14.8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />,
  table: <path d="M4 6h16v12H4zM4 11h16M9 6v12M15 6v12" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />,
  rowAddBefore: (
    <>
      <path d="M4 6h16v12H4zM4 11h16M9 6v12M15 6v12" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M12 2.8v3.4M10.3 4.5h3.4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </>
  ),
  rowAddAfter: (
    <>
      <path d="M4 6h16v12H4zM4 11h16M9 6v12M15 6v12" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M12 17.8v3.4M10.3 19.5h3.4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </>
  ),
  rowDelete: (
    <>
      <path d="M4 6h16v12H4zM4 11h16M9 6v12M15 6v12" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M9.5 19.5h5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </>
  ),
  columnAddBefore: (
    <>
      <path d="M4 6h16v12H4zM4 11h16M9 6v12M15 6v12" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M2.8 12h3.4M4.5 10.3v3.4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </>
  ),
  columnAddAfter: (
    <>
      <path d="M4 6h16v12H4zM4 11h16M9 6v12M15 6v12" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M17.8 12h3.4M19.5 10.3v3.4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </>
  ),
  columnDelete: (
    <>
      <path d="M4 6h16v12H4zM4 11h16M9 6v12M15 6v12" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M19.2 9.5v5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </>
  ),
  tableDelete: (
    <>
      <path d="M4 6h16v12H4zM4 11h16M9 6v12M15 6v12" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M17.2 4.8l2.8 2.8M20 4.8l-2.8 2.8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </>
  ),
  code: <path d="M9 8L5 12l4 4M15 8l4 4-4 4M13 6l-2 12" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />,
  math: <path d="M5 7l5 10M10 7L5 17M14 9h5M16.5 6.5v5M14 16h5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />,
  diagram: <path d="M6 6h5v4H6zM13 14h5v4h-5zM6 14h5v4H6zM8.5 10v2M8.5 12h7M15.5 12v2" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />,
  image: <path d="M4 6h16v12H4zM7 10h.01M6 16l4-4 3 3 3-4 4 5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />,
  footnote: <path d="M7 7h6M10 7v10M15 14l2-2v6" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />,
  source: <path d="M8 8L4 12l4 4M16 8l4 4-4 4M13 5l-2 14" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />,
  appearance: (
    <>
      <path
        d="M12 4a8 8 0 100 16 2.5 2.5 0 000-5h-.7a1.8 1.8 0 01-1.8-1.8 1.9 1.9 0 011.9-1.9H14a3 3 0 003-3 3.3 3.3 0 00-3.4-3.3z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <circle cx="8" cy="10" r="1" fill="currentColor" />
      <circle cx="10.5" cy="7.5" r="1" fill="currentColor" />
      <circle cx="14" cy="7.5" r="1" fill="currentColor" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 2.5v2.2M12 19.3v2.2M4.7 4.7l1.6 1.6M17.7 17.7l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.7 19.3l1.6-1.6M17.7 6.3l1.6-1.6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </>
  ),
  moon: (
    <path
      d="M14.5 3.5a8 8 0 108 8 6.3 6.3 0 01-8-8z"
      fill="none"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="1.8"
    />
  ),
  autoTheme: (
    <>
      <path
        d="M12 3.2a8.8 8.8 0 100 17.6 6.9 6.9 0 010-17.6z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M12 1.8v2M12 20.2v2M2 12h2M20 12h2"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </>
  ),
  cut: (
    <>
      <circle cx="7.5" cy="17" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="16.5" cy="17" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M9 15.2 15 4.5M15 15.2 9 4.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="10" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M7 15V7a2 2 0 012-2h8"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </>
  ),
  paste: (
    <>
      <path
        d="M8 7h8a2 2 0 012 2v10a2 2 0 01-2 2H8a2 2 0 01-2-2V9a2 2 0 012-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M10 7V6a2 2 0 012-2h0a2 2 0 012 2v1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </>
  ),
  selectAll: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M8 9h8M8 12h8M8 15h5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </>
  ),
};

const iconFileNames: Record<IconName, string> = {
  menu: 'menu.ico',
  newWindow: 'newWindow.ico',
  open: 'open.ico',
  folder: 'folder.ico',
  save: 'save.ico',
  saveAs: 'saveAs.ico',
  search: 'search.ico',
  sidebar: 'sidebar.ico',
  heading1: 'heading1.ico',
  heading2: 'heading2.ico',
  bold: 'bold.ico',
  italic: 'italic.ico',
  underline: 'underline.ico',
  strike: 'strike.ico',
  link: 'link.ico',
  quote: 'quote.ico',
  bullet: 'bullet.ico',
  ordered: 'ordered.ico',
  task: 'task.ico',
  table: 'table.ico',
  rowAddBefore: 'table.ico',
  rowAddAfter: 'table.ico',
  rowDelete: 'table.ico',
  columnAddBefore: 'table.ico',
  columnAddAfter: 'table.ico',
  columnDelete: 'table.ico',
  tableDelete: 'table.ico',
  code: 'code.ico',
  math: 'math.ico',
  diagram: 'diagram.ico',
  image: 'image.ico',
  footnote: 'footnote.ico',
  source: 'source.ico',
  appearance: 'appearance.ico',
  sun: 'sun.ico',
  moon: 'moon.ico',
  autoTheme: 'autoTheme.ico',
  cut: 'menu.ico',
  copy: 'menu.ico',
  paste: 'menu.ico',
  selectAll: 'menu.ico',
};

function buildIconAssetMap(folderName: 'ico_dark' | 'ico_light'): Record<IconName, string> {
  return Object.fromEntries(
    Object.entries(iconFileNames).map(([key, fileName]) => [
      key,
      new URL(`../../../build/toolbar/${folderName}/${fileName}`, import.meta.url).toString(),
    ]),
  ) as Record<IconName, string>;
}

const iconAssetsForLightMode = buildIconAssetMap('ico_dark');
const iconAssetsForDarkMode = buildIconAssetMap('ico_light');
const vectorOnlyIcons = new Set<IconName>([
  'rowAddBefore',
  'rowAddAfter',
  'rowDelete',
  'columnAddBefore',
  'columnAddAfter',
  'columnDelete',
  'tableDelete',
  'cut',
  'copy',
  'paste',
  'selectAll',
]);

const loadedIconAssets = new Set<string>();
const loadingIconAssets = new Map<string, Promise<void>>();

function loadIconAsset(asset: string): Promise<void> {
  if (loadedIconAssets.has(asset)) {
    return Promise.resolve();
  }

  const loading = loadingIconAssets.get(asset);
  if (loading) {
    return loading;
  }

  const promise = new Promise<void>((resolve, reject) => {
    const image = new window.Image();
    image.decoding = 'async';
    image.onload = () => {
      loadedIconAssets.add(asset);
      loadingIconAssets.delete(asset);
      resolve();
    };
    image.onerror = () => {
      loadingIconAssets.delete(asset);
      reject(new Error(`Failed to load icon asset: ${asset}`));
    };
    image.src = asset;
  });

  loadingIconAssets.set(asset, promise);
  return promise;
}

function scheduleBackgroundTask(task: () => void, timeoutMs: number): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (idleWindow.requestIdleCallback) {
    const handle = idleWindow.requestIdleCallback(task, { timeout: timeoutMs });
    return () => {
      idleWindow.cancelIdleCallback?.(handle);
    };
  }

  const timeoutHandle = window.setTimeout(task, Math.min(timeoutMs, 500));
  return () => {
    window.clearTimeout(timeoutHandle);
  };
}

function useAsyncIconAsset(asset: string | null, timeoutMs = 1200): boolean {
  const [loaded, setLoaded] = useState(() => (asset ? loadedIconAssets.has(asset) : false));

  useEffect(() => {
    if (!asset) {
      setLoaded(false);
      return;
    }

    if (loadedIconAssets.has(asset)) {
      setLoaded(true);
      return;
    }

    setLoaded(false);
    let cancelled = false;
    const cancelTask = scheduleBackgroundTask(() => {
      void loadIconAsset(asset)
        .then(() => {
          if (!cancelled) {
            setLoaded(true);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setLoaded(false);
          }
        });
    }, timeoutMs);

    return () => {
      cancelled = true;
      cancelTask();
    };
  }, [asset, timeoutMs]);

  return loaded;
}

function resolveIsDarkMode(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }

  const rootTheme = document.documentElement.getAttribute('data-theme');
  const shellTheme = document.querySelector('.app-shell')?.getAttribute('data-theme');
  const currentTheme = rootTheme ?? shellTheme;

  if (currentTheme === 'dark') {
    return true;
  }

  if (currentTheme === 'light') {
    return false;
  }

  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function useReactiveDarkMode(): boolean {
  const [isDarkMode, setIsDarkMode] = useState(() => resolveIsDarkMode());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    const update = () => {
      setIsDarkMode(resolveIsDarkMode());
    };

    update();

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleMediaChange = () => update();
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleMediaChange);
    } else {
      mediaQuery.addListener(handleMediaChange);
    }

    const observer = new MutationObserver(() => update());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    const appShell = document.querySelector('.app-shell');
    if (appShell instanceof HTMLElement) {
      observer.observe(appShell, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
    }

    return () => {
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', handleMediaChange);
      } else {
        mediaQuery.removeListener(handleMediaChange);
      }
      observer.disconnect();
    };
  }, []);

  return isDarkMode;
}

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
}

export default function Icon({ name, ...props }: IconProps) {
  const isDarkMode = useReactiveDarkMode();
  const lightAsset = iconAssetsForLightMode[name];
  const darkAsset = iconAssetsForDarkMode[name];
  const activeAsset = isDarkMode ? darkAsset : lightAsset;
  const backupAsset = isDarkMode ? lightAsset : darkAsset;
  const activeLoaded = useAsyncIconAsset(activeAsset, 1400);
  const shouldUseRaster = !vectorOnlyIcons.has(name) && Boolean(activeAsset && activeLoaded);

  useEffect(() => {
    if (!backupAsset || loadedIconAssets.has(backupAsset)) {
      return;
    }

    const cancelTask = scheduleBackgroundTask(() => {
      void loadIconAsset(backupAsset).catch(() => {});
    }, 3200);

    return cancelTask;
  }, [backupAsset]);

  if (shouldUseRaster && activeAsset) {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" {...props}>
        <image href={activeAsset} width="24" height="24" preserveAspectRatio="xMidYMid meet" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" {...props}>
      {iconPaths[name]}
    </svg>
  );
}
