import clsx from 'clsx';
import type { FolderEntry } from '@shared/contracts';
import type { OutlineItem } from '../utils/document';
import { formatFolderDate } from '../utils/document';
import { translate } from '../i18n';

type SidebarTab = 'files' | 'outline';

interface SidebarProps {
  visible: boolean;
  tab: SidebarTab;
  currentFilePath: string | null;
  folderPath: string | null;
  folderEntries: FolderEntry[];
  outline: OutlineItem[];
  onSelectTab: (tab: SidebarTab) => void;
  onOpenFolder: () => void;
  onOpenFile: (filePath: string) => void;
  onNavigateOutline: (index: number) => void;
}

export default function Sidebar({
  visible,
  tab,
  currentFilePath,
  folderPath,
  folderEntries,
  outline,
  onSelectTab,
  onOpenFolder,
  onOpenFile,
  onNavigateOutline,
}: SidebarProps) {
  return (
    <aside className={clsx('sidebar', !visible && 'is-hidden')}>
      <div className="sidebar__tabs">
        <button
          className={clsx('sidebar__tab', tab === 'files' && 'is-active')}
          onClick={() => onSelectTab('files')}
          type="button"
        >
          {translate('sidebarFiles')}
        </button>
        <button
          className={clsx('sidebar__tab', tab === 'outline' && 'is-active')}
          onClick={() => onSelectTab('outline')}
          type="button"
        >
          {translate('sidebarOutline')}
        </button>
      </div>

      {tab === 'files' ? (
        <div className="sidebar__panel">
          <div className="sidebar__panel-header">
            <div className="sidebar__panel-title">{translate('sidebarFolder')}</div>
            <button className="sidebar__action" onClick={onOpenFolder} type="button">
              {translate('sidebarOpen')}
            </button>
          </div>

          {folderPath ? <div className="sidebar__path">{folderPath}</div> : null}

          <div className="sidebar__list">
            {folderEntries.length > 0 ? (
              folderEntries.map((entry) => (
                <button
                  key={entry.path}
                  className={clsx('file-item', currentFilePath === entry.path && 'is-active')}
                  onClick={() => onOpenFile(entry.path)}
                  type="button"
                >
                  <div className="file-item__meta">
                    <span className="file-item__kind">Markdown</span>
                    <span className="file-item__date">{formatFolderDate(entry.modifiedAt)}</span>
                  </div>
                  <div className="file-item__title">{entry.title}</div>
                  <div className="file-item__path">{entry.path}</div>
                </button>
              ))
            ) : (
              <div className="sidebar__empty">
                {translate('sidebarFolderEmpty')}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="sidebar__panel">
          <div className="sidebar__panel-header">
            <div className="sidebar__panel-title">{translate('sidebarOutline')}</div>
          </div>

          <div className="sidebar__list">
            {outline.length > 0 ? (
              outline.map((item, index) => (
                <button
                  key={item.id}
                  className={`outline-item level-${item.level}`}
                  onClick={() => onNavigateOutline(index)}
                  type="button"
                >
                  {item.text}
                </button>
              ))
            ) : (
              <div className="sidebar__empty">
                {translate('sidebarOutlineEmpty')}
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
