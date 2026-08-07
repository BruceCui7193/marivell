import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface ImageActionMenuProps {
  x: number;
  y: number;
  currentPathAvailable: boolean;
  originalPathAvailable: boolean;
  onCopyToCurrent: () => void;
  onKeepOriginal: () => void;
  onCopyToOther: () => void;
  onClose: () => void;
}

export default function ImageActionMenu({
  x,
  y,
  currentPathAvailable,
  originalPathAvailable,
  onCopyToCurrent,
  onKeepOriginal,
  onCopyToOther,
  onClose,
}: ImageActionMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });
  const [origin, setOrigin] = useState('top left');

  useLayoutEffect(() => {
    if (!rootRef.current) {
      return;
    }

    const el = rootRef.current;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    const nextX = Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad));
    const nextY = Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad));
    setPos({ x: nextX, y: nextY });
    setOrigin(`${nextY + rect.height > window.innerHeight - pad ? 'bottom' : 'top'} ${nextX + rect.width > window.innerWidth - pad ? 'right' : 'left'}`);
  }, [x, y]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!(target instanceof HTMLElement) || !target.closest('.image-action-menu')) {
        onClose();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  return (
    <div ref={rootRef} className="image-action-menu" role="menu" style={{ left: pos.x, top: pos.y, transformOrigin: origin }}>
      <div className="image-action-menu__title">图片操作</div>
      <button
        className={`image-action-menu__item${currentPathAvailable ? '' : ' is-pending-save'}`}
        onClick={onCopyToCurrent}
        onMouseDown={(event) => event.preventDefault()}
        role="menuitem"
        type="button"
      >
        <span>复制到当前路径</span>
        {currentPathAvailable ? null : <span className="image-action-menu__hint">需先保存文档</span>}
      </button>
      <button
        className="image-action-menu__item"
        disabled={!originalPathAvailable}
        onClick={onKeepOriginal}
        onMouseDown={(event) => event.preventDefault()}
        role="menuitem"
        type="button"
      >
        <span>保留原路径</span>
        {originalPathAvailable ? null : <span className="image-action-menu__hint">剪贴板无路径</span>}
      </button>
      <button
        className="image-action-menu__item"
        onClick={onCopyToOther}
        onMouseDown={(event) => event.preventDefault()}
        role="menuitem"
        type="button"
      >
        <span>复制到其它位置…</span>
      </button>
    </div>
  );
}
