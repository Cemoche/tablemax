import { useEffect, useRef, useState, type FormEvent } from "react";
import { isImportExpired, isWrongExportPassword, toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { AppError, ImportItem, ImportPreview, ImportWarning } from "../../lib/types";
import { useConnections } from "../../stores/connections";

interface Props {
  onClose: () => void;
}

type Step =
  | { step: "password" }
  | { step: "select"; preview: ImportPreview; checked: Set<number> }
  | { step: "done"; count: number; warnings: ImportWarning[]; reloadFailed: boolean };

const PILL = "rounded-sm border px-1 text-xs";
const BUTTON = "rounded-sm border border-border px-3 py-1 disabled:opacity-50";
const PRIMARY = "rounded-sm bg-accent-strong px-3 py-1 text-accent-contrast disabled:opacity-50";

function Warnings({ warnings }: { warnings: ImportWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="text-muted">{strings.import.warningsTitle}</p>
      <ul className="list-disc pl-5 text-warning">
        {warnings.map((w, i) => (
          <li key={i}>{strings.import.warning(w.entry, w.message)}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Imports connections from a TablePlus export: password + native picker, then a
 * checklist of the entries (duplicates unchecked), then the outcome. A preview that is
 * not committed is discarded when the dialog goes away, so its secrets do not linger.
 */
export function ImportDialog({ onClose }: Props) {
  const items = useConnections((s) => s.items);
  const load = useConnections((s) => s.load);
  const [password, setPassword] = useState("");
  const [state, setState] = useState<Step>({ step: "password" });
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  /** The previewed import not committed yet (discarded on close). */
  const pending = useRef<string | null>(null);
  const mounted = useRef(true);

  const discard = (importId: string) => void ipc.importTablePlusDiscard(importId).catch(() => {});
  const close = () => {
    if (pending.current) discard(pending.current);
    pending.current = null;
    onClose();
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pending.current) discard(pending.current);
      pending.current = null;
    };
  }, []);

  useEffect(() => {
    // Taken (preventDefault): the connection form behind does not close on the same press.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** Reads the export: the last picked file again with `reusePick`, else a new pick. */
  const read = async (reusePick: boolean) => {
    setBusy(true);
    try {
      const preview = await ipc.importTablePlusPreview(password, reusePick);
      if (!mounted.current) {
        if (preview) discard(preview.importId);
        return;
      }
      // A cancelled picker changes nothing.
      if (!preview) return;
      pending.current = preview.importId;
      const checked = new Set(preview.items.filter((i) => !i.duplicateOf).map((i) => i.index));
      setError(null);
      setState({ step: "select", preview, checked });
    } catch (e) {
      if (mounted.current) setError(toAppError(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const commit = async (preview: ImportPreview, checked: Set<number>) => {
    setBusy(true);
    setError(null);
    try {
      const indexes = [...checked].sort((a, b) => a - b);
      const result = await ipc.importTablePlusCommit(preview.importId, indexes);
      pending.current = null;
      const reloadFailed = await load().then(
        () => false,
        () => true,
      );
      if (!mounted.current) return;
      setState({ step: "done", count: result.saved.length, warnings: result.warnings, reloadFailed });
    } catch (e) {
      if (!mounted.current) return;
      const err = toAppError(e);
      setError(err);
      if (isImportExpired(err)) {
        pending.current = null;
        setState({ step: "password" });
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  // The same file is worth reading again after a wrong password or an expired preview.
  const canRetry = error !== null && (isWrongExportPassword(error) || isImportExpired(error));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (state.step === "password") void read(canRetry);
    else if (state.step === "select") void commit(state.preview, state.checked);
    else close();
  };

  const nameOf = (id: string) => items.find((c) => c.id === id)?.name ?? id;
  const row = (item: ImportItem, checked: Set<number>, preview: ImportPreview) => {
    const c = item.config;
    const where = c.kind === "sqlite" ? (c.sqlitePath ?? "") : `${c.host}:${c.port}`;
    const toggle = () => {
      const next = new Set(checked);
      if (!next.delete(item.index)) next.add(item.index);
      setState({ step: "select", preview, checked: next });
    };
    return (
      <li key={item.index}>
        <label className="flex items-start gap-2 px-2 py-1 hover:bg-surface-2">
          <input type="checkbox" checked={checked.has(item.index)} onChange={toggle} className="mt-1" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-2">
              <span className="min-w-0 truncate font-medium">{c.name}</span>
              {item.hasPassword && <span className={`${PILL} border-border`}>{strings.import.pillPassword}</span>}
              {c.ssh && <span className={`${PILL} border-border`}>{strings.import.pillSsh}</span>}
              {item.duplicateOf && (
                <span className={`${PILL} border-warning text-warning`}>
                  {strings.import.duplicateOf(nameOf(item.duplicateOf))}
                </span>
              )}
            </span>
            <span className="flex gap-2 text-xs text-muted">
              <span>{strings.driver[c.kind]}</span>
              <span className="min-w-0 truncate font-mono">{where}</span>
              {c.ssh && <span className="shrink-0">{strings.import.viaSsh(c.ssh.host)}</span>}
              {c.group && <span className="min-w-0 truncate">{c.group}</span>}
            </span>
          </span>
        </label>
      </li>
    );
  };

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-bg/70">
      <form
        role="dialog"
        aria-modal="true"
        aria-label={strings.import.title}
        onSubmit={submit}
        className="flex max-h-[90vh] w-[40rem] flex-col rounded-md border border-border bg-surface p-4 shadow-lg"
      >
        <h2 className="mb-2 text-lg font-semibold">{strings.import.title}</h2>

        {state.step === "password" && (
          <label className="flex flex-col gap-1">
            <span className="text-muted">{strings.import.password}</span>
            <input
              autoFocus
              type="password"
              autoComplete="off"
              aria-label={strings.import.password}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-sm border border-border bg-bg px-2 py-1"
            />
            <span className="text-xs text-muted">{strings.import.passwordHint}</span>
          </label>
        )}

        {state.step === "select" && (
          <>
            <ul
              aria-label={strings.import.listLabel}
              className="min-h-0 flex-1 overflow-y-auto rounded-sm border border-border"
            >
              {state.preview.items.map((item) => row(item, state.checked, state.preview))}
            </ul>
            <Warnings warnings={state.preview.warnings} />
          </>
        )}

        {state.step === "done" && (
          <>
            <p role="status">{strings.import.done(state.count)}</p>
            {state.reloadFailed && <p className="mt-2 text-danger-text">{strings.connections.loadFailed}</p>}
            <Warnings warnings={state.warnings} />
          </>
        )}

        {error && (
          <p role="alert" className="mt-2 text-danger-text">
            {error.message}
          </p>
        )}

        <div className="mt-3 flex justify-end gap-2">
          {state.step === "done" ? (
            <button type="submit" className={PRIMARY}>
              {strings.import.close}
            </button>
          ) : (
            <button type="button" onClick={close} className={BUTTON}>
              {strings.import.cancel}
            </button>
          )}
          {state.step === "password" && error && (
            <button
              type={canRetry ? "button" : "submit"}
              disabled={busy}
              onClick={canRetry ? () => void read(false) : undefined}
              className={canRetry ? BUTTON : PRIMARY}
            >
              {strings.import.chooseAnother}
            </button>
          )}
          {state.step === "password" && (!error || canRetry) && (
            <button type="submit" disabled={busy} className={PRIMARY}>
              {busy ? strings.import.reading : error ? strings.import.retry : strings.import.chooseFile}
            </button>
          )}
          {state.step === "select" && (
            <button type="submit" disabled={busy || state.checked.size === 0} className={PRIMARY}>
              {busy ? strings.import.importing : strings.import.submit(state.checked.size)}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
