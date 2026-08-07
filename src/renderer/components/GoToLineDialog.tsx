import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { translate, useAppLanguage } from '../i18n';

interface GoToLineDialogProps {
  defaultValue: string;
  onCancel: () => void;
  onSubmit: (line: number) => void;
}

export default function GoToLineDialog({
  defaultValue,
  onCancel,
  onSubmit,
}: GoToLineDialogProps) {
  useAppLanguage();
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  const submit = () => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isNaN(parsed)) {
      onSubmit(Math.max(1, parsed));
    }
  };

  return createPortal(
    <div
      className="app-dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <section aria-label={translate('goToLineTitle')} aria-modal="true" className="app-dialog" role="dialog">
        <h2 className="app-dialog__title">{translate('goToLineTitle')}</h2>
        <p className="app-dialog__message">{translate('goToLineMessage')}</p>
        <input
          className="app-dialog__input"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
          ref={inputRef}
          spellCheck={false}
          type="text"
          value={value}
        />
        <div className="app-dialog__actions">
          <button className="app-dialog__button" onClick={onCancel} type="button">
            {translate('cancel')}
          </button>
          <button className="app-dialog__button is-primary" onClick={submit} type="button">
            {translate('jump')}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
