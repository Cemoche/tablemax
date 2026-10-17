import { useEffect } from "react";

interface Props {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A modal asking to confirm a destructive action; Escape cancels, Cancel has the focus. */
export function ConfirmDialog({ title, message, confirmLabel, cancelLabel, onConfirm, onCancel }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-bg/70">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-80 rounded-md border border-border bg-surface p-4 shadow-lg"
      >
        <h2 className="mb-1 text-lg font-semibold">{title}</h2>
        <p className="mb-3 text-muted">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="rounded-sm border border-border px-3 py-1"
          >
            {cancelLabel}
          </button>
          <button type="button" onClick={onConfirm} className="rounded-sm bg-danger px-3 py-1 text-accent-contrast">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
