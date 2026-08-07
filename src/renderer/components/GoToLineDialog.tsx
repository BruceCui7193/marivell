import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
      <section aria-label="转到行" aria-modal="true" className="app-dialog" role="dialog">
        <h2 className="app-dialog__title">转到行</h2>
        <p className="app-dialog__message">输入要跳转到的行号</p>
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
            取消
          </button>
          <button className="app-dialog__button is-primary" onClick={submit} type="button">
            跳转
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
