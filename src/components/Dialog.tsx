import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

/** Native modal <dialog>. Rendered only while open; Escape and backdrop clicks call onClose. */
export function Dialog({
  title,
  onClose,
  children,
  className,
  onKeyDown,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLDialogElement>) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Close on backdrop click only if the press also started on the backdrop; otherwise
  // drag-selecting text in a field and releasing outside would close the dialog.
  const pressedBackdrop = useRef(false);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={className}
      onKeyDown={onKeyDown}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === ref.current;
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === ref.current) onClose();
        pressedBackdrop.current = false;
      }}
    >
      <div className="dialog-body">
        <h2 style={{ fontSize: 16 }}>{title}</h2>
        {children}
      </div>
    </dialog>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      <p style={{ margin: 0 }}>{message}</p>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose} autoFocus>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={async () => {
            await onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
