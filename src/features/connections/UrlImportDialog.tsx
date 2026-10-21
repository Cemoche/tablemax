import { useEffect, useMemo, useState } from "react";
import { parseConnectionUrl } from "../../lib/connectionUrl";
import { strings } from "../../lib/strings";
import type { ConnectionConfig } from "../../lib/types";

interface Props {
  onResult: (config: Partial<ConnectionConfig>, password: string | null, sslExplicit: boolean) => void;
  onCancel: () => void;
}

/** Modal to paste a connection URL; shows what the parser warns about before opening the form. */
export function UrlImportDialog({ onResult, onCancel }: Props) {
  const [text, setText] = useState("");
  useEffect(() => {
    // Taken (preventDefault): the connection form behind does not close on the same press.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    try {
      return { ok: parseConnectionUrl(text) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : strings.url.invalid };
    }
  }, [text]);
  const ok = parsed && "ok" in parsed ? parsed.ok : null;

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-bg/70">
      <form
        role="dialog"
        aria-modal="true"
        aria-label={strings.url.dialogTitle}
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onResult(ok.config, ok.password, ok.sslExplicit);
        }}
        className="w-[32rem] rounded-md border border-border bg-surface p-4 shadow-lg"
      >
        <h2 className="mb-2 text-lg font-semibold">{strings.url.dialogTitle}</h2>
        <label className="flex flex-col gap-1">
          <span className="text-muted">{strings.url.label}</span>
          <input
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={text}
            placeholder={strings.url.placeholder}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-sm border border-border bg-bg px-2 py-1 font-mono outline-none focus-visible:focus-ring"
          />
        </label>
        {parsed && "error" in parsed && (
          <p role="alert" className="mt-2 text-danger-text">
            {parsed.error}
          </p>
        )}
        {ok?.password && <p className="mt-2 text-muted">{strings.url.passwordNote}</p>}
        {ok && ok.warnings.length > 0 && (
          <div className="mt-2">
            <p className="text-muted">{strings.url.warningsTitle}</p>
            <ul role="list" className="list-disc pl-5">
              {ok.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-sm border border-border px-3 py-1 outline-none focus-visible:focus-ring">
            {strings.url.cancel}
          </button>
          <button
            type="submit"
            disabled={!ok}
            className="rounded-sm bg-accent-strong px-3 py-1 text-accent-contrast outline-none focus-visible:focus-ring disabled:opacity-50"
          >
            {strings.url.open}
          </button>
        </div>
      </form>
    </div>
  );
}
