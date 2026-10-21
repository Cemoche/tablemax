import { type FormEvent, type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { useRestoreFocus } from "../../lib/useRestoreFocus";

/**
 * Small in-app modal dialogs of the SQL tab (Plan 4 Task 8): `aria-modal` (so app
 * shortcuts pause while they are open), Escape cancels, Tab stays inside, and focus
 * returns to where it was when the dialog closes.
 */
function Modal({
  role,
  title,
  body,
  onCancel,
  onSubmit,
  children,
}: {
  role: "dialog" | "alertdialog";
  title: string;
  body?: string;
  onCancel: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const bodyId = useId();
  const ref = useRef<HTMLFormElement>(null);
  useRestoreFocus();
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Tab" && ref.current) {
      const items = Array.from(
        ref.current.querySelectorAll<HTMLElement>("input, button:not([disabled])"),
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-bg/70">
      <form
        ref={ref}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={body ? bodyId : undefined}
        onKeyDown={onKeyDown}
        onSubmit={submit}
        className="w-96 rounded-md border border-border bg-surface p-4 shadow-lg"
      >
        <h2 id={titleId} className="mb-2 text-lg font-semibold">
          {title}
        </h2>
        {body && (
          <p id={bodyId} className="mb-3 text-muted">
            {body}
          </p>
        )}
        {children}
      </form>
    </div>
  );
}

const btn = "rounded-sm border border-border px-3 py-1 hover:bg-surface-2 outline-none focus-visible:focus-ring";

export function ConfirmDialog({
  title,
  body,
  confirm,
  cancel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirm: string;
  cancel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal role="alertdialog" title={title} body={body} onCancel={onCancel} onSubmit={onConfirm}>
      <div className="flex justify-end gap-2">
        {/* The safe choice has the focus. */}
        <button type="button" autoFocus onClick={onCancel} className={btn}>
          {cancel}
        </button>
        <button
          type="submit"
          className={`rounded-sm px-3 py-1 outline-none focus-visible:focus-ring ${danger ? "border border-danger text-danger-text hover:bg-surface-2" : "bg-accent-strong text-accent-contrast"}`}
        >
          {confirm}
        </button>
      </div>
    </Modal>
  );
}

/** Asks for a name; `error` (from the backend) is shown under the field. */
export function NameDialog({
  title,
  label,
  initial = "",
  confirm,
  cancel,
  error,
  busy = false,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  initial?: string;
  confirm: string;
  cancel: string;
  error?: string | null;
  busy?: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const errorId = useId();
  return (
    <Modal role="dialog" title={title} onCancel={onCancel} onSubmit={() => name.trim() && onSubmit(name)}>
      <input
        autoFocus
        type="text"
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        className="w-full rounded-sm border border-border bg-bg px-2 py-1 outline-none focus-visible:focus-ring"
      />
      {error && (
        <p id={errorId} role="alert" className="mt-2 text-danger-text">
          {error}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={btn}>
          {cancel}
        </button>
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="rounded-sm bg-accent-strong px-3 py-1 text-accent-contrast outline-none focus-visible:focus-ring disabled:opacity-40"
        >
          {confirm}
        </button>
      </div>
    </Modal>
  );
}
