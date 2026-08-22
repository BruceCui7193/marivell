import { useEffect, useState, type SVGProps } from 'react';

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

if (typeof window !== 'undefined') {
  const initialAssets = resolveIsDarkMode()
    ? iconAssetsForDarkMode
    : iconAssetsForLightMode;
  for (const asset of Object.values(initialAssets)) {
    void loadIconAsset(asset).catch(() => {});
  }
}

function useLoadedIconAsset(asset: string): boolean {
  const [loaded, setLoaded] = useState(() => loadedIconAssets.has(asset));

  useEffect(() => {
    if (loadedIconAssets.has(asset)) {
      setLoaded(true);
      return;
    }

    let cancelled = false;
    setLoaded(false);
    void loadIconAsset(asset)
      .then(() => {
        if (!cancelled) setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(false);
      });

    return () => {
      cancelled = true;
    };
  }, [asset]);

  return loaded;
}

function useReactiveDarkMode(): boolean {
  const [isDarkMode, setIsDarkMode] = useState(() => resolveIsDarkMode());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    const update = () => setIsDarkMode(resolveIsDarkMode());
    update();

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleMediaChange = () => update();
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleMediaChange);
    } else {
      mediaQuery.addListener(handleMediaChange);
    }

    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
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
  const activeAsset = isDarkMode
    ? iconAssetsForDarkMode[name]
    : iconAssetsForLightMode[name];
  const loaded = useLoadedIconAsset(activeAsset);

  if (!loaded) {
    return <svg aria-hidden="true" data-icon-loading="" viewBox="0 0 24 24" {...props} />;
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" {...props}>
      <image href={activeAsset} width="24" height="24" preserveAspectRatio="xMidYMid meet" />
    </svg>
  );
}
