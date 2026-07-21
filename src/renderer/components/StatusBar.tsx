import type { DocumentStats } from '../App';
import type { SourceCursorInfo } from './SourceEditor';

interface StatusBarProps {
  stats: DocumentStats;
  dirty: boolean;
  title: string;
  lastSavedAt: number | null;
  sourceMode?: boolean;
  sourceCursor?: SourceCursorInfo | null;
}

function formatTime(timestamp: number | null): string {
  if (!timestamp) {
    return '尚未保存';
  }

  return new Intl.DateTimeFormat('zh-CN', {
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
  const readingMinutes = estimateReadingMinutes(stats.words);

  return (
    <footer className="status-bar">
      <div className="status-bar__left">
        <span className={dirty ? 'status-bar__badge is-dirty' : 'status-bar__badge'}>
          {dirty ? '未保存修改' : '已保存'}
        </span>
        <span className="status-bar__mode" title={sourceMode ? 'Source' : 'Visual'}>
          {sourceMode ? '源码' : '可视化'}
        </span>
        <span className="status-bar__title" title={title}>
          {title}
        </span>
      </div>
      <div className="status-bar__right">
        {sourceMode && sourceCursor ? (
          <span title="Ctrl+G 跳转到行">
            行 {sourceCursor.line}，列 {sourceCursor.column}
          </span>
        ) : null}
        <span>{stats.lines} 行</span>
        <span>{stats.words} 字</span>
        <span>{stats.characters} 字符</span>
        {readingMinutes > 0 ? <span>约 {readingMinutes} 分钟</span> : null}
        <span>{formatTime(lastSavedAt)}</span>
      </div>
    </footer>
  );
}
