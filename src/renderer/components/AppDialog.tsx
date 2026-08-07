import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import { createPortal } from 'react-dom';

export type AppDialogButtonVariant = 'primary' | 'danger' | 'ghost';

export interface AppDialogButton {
  value: string;
  label: string;
  variant?: AppDialogButtonVariant;
}

export interface AppDialogOptions {
  title: string;
  message: string;
  detail?: string;
  buttons: AppDialogButton[];
  cancelValue?: string;
  onResolve: (value: string) => void;
}

interface AppDialogProps extends AppDialogOptions {
  onResolve: (value: string) => void;
}

export default function AppDialog({
  title,
  message,
  detail,
  buttons,
  cancelValue,
  onResolve,
}: AppDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const preferred = dialogRef.current?.querySelector<HTMLButtonElement>(
      '.app-dialog__button.is-primary, .app-dialog__button.is-danger, .app-dialog__button',
    );
    preferred?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && cancelValue) {
        event.preventDefault();
        event.stopPropagation();
        onResolve(cancelValue);
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [cancelValue, onResolve]);

  return createPortal(
    <div className="app-dialog-overlay" ref={dialogRef}>
      <section
        aria-label={title}
        aria-modal="true"
        className="app-dialog"
        role="alertdialog"
      >
        <h2 className="app-dialog__title">{title}</h2>
        <p className="app-dialog__message">{message}</p>
        {detail ? <p className="app-dialog__detail">{detail}</p> : null}
        <div className="app-dialog__actions">
          {buttons.map((button) => (
            <button
              className={clsx(
                'app-dialog__button',
                button.variant === 'danger' && 'is-danger',
                button.variant === 'primary' && 'is-primary',
                (!button.variant || button.variant === 'ghost') && 'is-ghost',
              )}
              key={button.value}
              onClick={() => onResolve(button.value)}
              type="button"
            >
              {button.label}
            </button>
          ))}
        </div>
      </section>
    </div>,
    document.body,
  );
}
