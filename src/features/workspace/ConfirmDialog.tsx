import { useEffect } from "react";

interface Props {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * The button focused on open (Enter presses it). Default "cancel"; "confirm" for a dialog
   * that is itself the guard of a deliberate key press (Discard's shortcut, #90).
   */
  initialFocus?: "cancel" | "confirm";
}

/** A modal asking to confirm a destructive action; Escape cancels (not its repeats), Cancel has the focus by default. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  initialFocus = "cancel",
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // A held key acts once: its repeats never cancel a question they just opened.
        if (!e.repeat) onCancel();
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
            autoFocus={initialFocus === "cancel"}
            onClick={onCancel}
            className="rounded-sm border border-border px-3 py-1 outline-none focus-visible:focus-ring"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            autoFocus={initialFocus === "confirm"}
            onClick={onConfirm}
            className="rounded-sm bg-danger-strong px-3 py-1 text-danger-contrast outline-none focus-visible:focus-ring"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
