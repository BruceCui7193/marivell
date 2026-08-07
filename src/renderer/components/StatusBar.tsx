import type { DocumentStats } from '../App';
import type { SourceCursorInfo } from './SourceEditor';
import { translate, useAppLanguage } from '../i18n';

interface StatusBarProps {
  stats: DocumentStats;
  dirty: boolean;
  title: string;
  lastSavedAt: number | null;
  sourceMode?: boolean;
  sourceCursor?: SourceCursorInfo | null;
}

function formatTime(timestamp: number | null, language: string): string {
  if (!timestamp) {
    return translate('notSaved');
  }

  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function estimateReadingMinutes(words: number): number {
  // ~400 CJK-equivalent units/min mixed reading; floor at 1 when non-empty.
  if (words <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(words / 400));
}

export default function StatusBar({
  stats,
  dirty,
  title,
  lastSavedAt,
  sourceMode = false,
  sourceCursor = null,
}: StatusBarProps) {
  const appLanguage = useAppLanguage();
  const readingMinutes = estimateReadingMinutes(stats.words);

  return (
    <footer className="status-bar">
      <div className="status-bar__left">
        <span className={dirty ? 'status-bar__badge is-dirty' : 'status-bar__badge'}>
          {dirty ? translate('unsaved') : translate('saved')}
        </span>
        <span
          className="status-bar__mode"
          title={sourceMode ? translate('source') : translate('visual')}
        >
          {sourceMode ? translate('source') : translate('visual')}
        </span>
        <span className="status-bar__title" title={title}>
          {title}
        </span>
      </div>
      <div className="status-bar__right">
        {sourceMode && sourceCursor ? (
          <span title={`Ctrl+G ${translate('goToLine')}`}>
            {translate('lineColumn', {
              line: sourceCursor.line,
              column: sourceCursor.column,
            })}
          </span>
        ) : null}
        <span>{stats.lines} {translate('lines')}</span>
        <span>{stats.words} {translate('words')}</span>
        <span>{stats.characters} {translate('characters')}</span>
        {readingMinutes > 0 ? (
          <span>{translate('aboutMinutes', { count: readingMinutes })}</span>
        ) : null}
        <span>{formatTime(lastSavedAt, appLanguage)}</span>
      </div>
    </footer>
  );
}
