import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import Icon from './icons';
import type { ComponentProps } from 'react';

export type ContextMenuIconName = ComponentProps<typeof Icon>['name'];

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ContextMenuIconName;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: false;
  onSelect: () => void;
}

export interface ContextMenuSeparator {
  id: string;
  separator: true;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuEntry[];
}

interface ContextMenuProps {
  menu: ContextMenuState | null;
  onClose: () => void;
}

function isItem(entry: ContextMenuEntry): entry is ContextMenuItem {
  return !('separator' in entry && entry.separator);
}

export default function ContextMenu({ menu, onClose }: ContextMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !rootRef.current) {
      return;
    }

    const el = rootRef.current;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    const maxH = Math.min(420, window.innerHeight - pad * 2);
    // Prefer opening upward when near the bottom so the menu stays on-screen.
    let y = menu.y;
    if (menu.y + Math.min(rect.height, maxH) > window.innerHeight - pad) {
      y = Math.max(pad, menu.y - Math.min(rect.height, maxH));
    }
    const x = Math.min(menu.x, window.innerWidth - rect.width - pad);
    setPos({
      x: Math.max(pad, x),
      y: Math.max(pad, Math.min(y, window.innerHeight - Math.min(rect.height, maxH) - pad)),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) {
      return;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    const onPointer = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }
      onClose();
    };

    const onScroll = () => onClose();
    const onBlur = () => onClose();

    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onPointer, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onClose);

    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onPointer, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onClose);
    };
  }, [menu, onClose]);

  if (!menu) {
    return null;
  }

  return (
    <div
      ref={rootRef}
      className="context-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.items.map((entry) => {
        if (!isItem(entry)) {
          return <div className="context-menu__separator" key={entry.id} role="separator" />;
        }

        return (
          <button
            key={entry.id}
            className={clsx(
              'context-menu__item',
              entry.disabled && 'is-disabled',
              entry.danger && 'is-danger',
            )}
            disabled={entry.disabled}
            role="menuitem"
            type="button"
            onClick={() => {
              if (entry.disabled) return;
              entry.onSelect();
              onClose();
            }}
            onMouseDown={(event) => {
              // Keep focus from stealing before click on editor/source.
              event.preventDefault();
            }}
          >
            <span className="context-menu__icon">
              {entry.icon ? <Icon name={entry.icon} /> : null}
            </span>
            <span className="context-menu__label">{entry.label}</span>
            {entry.shortcut ? <span className="context-menu__shortcut">{entry.shortcut}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function sep(id: string): ContextMenuSeparator {
  return { id, separator: true };
}
