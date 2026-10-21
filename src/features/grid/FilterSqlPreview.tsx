import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { strings } from "../../lib/strings";
import { popoverButton, useDismiss } from "./PagePopover";

const f = strings.filters;

export type SqlPreviewState =
  | { status: "loading" }
  /** `sql`: the display text (values written in), never run. */
  | { status: "ready"; sql: string }
  | { status: "error"; message: string };

/**
 * The filter bar's SQL preview: the WHERE clause the page would use, read-only, with the
 * values written in as literals for reading and copying (#109). The page itself still sends
 * them apart as parameters: this text is never run. Not modal: Escape, Close or a press outside
 * close it; Escape and Close give the focus back to the SQL button. The clause gets the
 * focus once it is there, so it is read out and can be selected from the keyboard.
 */
export function FilterSqlPreview({ state, onClose }: { state: SqlPreviewState; onClose: (refocus: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLElement>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  useDismiss(ref, onClose);
  useEffect(() => {
    (body.current ?? ref.current)?.focus();
  }, [state.status]);

  // Its own Escape, stopped here: the bar would take it to hide itself.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose(true);
  };
  const doCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };

  const ring =
    "outline-none focus-visible:focus-ring";
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={f.sqlPreviewLabel}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="absolute top-full left-0 z-40 mt-1 flex w-[32rem] max-w-[80vw] flex-col gap-2 rounded-lg border border-pill-border bg-pill p-2 text-sm text-text shadow-lg outline-none"
    >
      {state.status === "loading" && <p role="status">{f.sqlLoading}</p>}
      {state.status === "error" && (
        <p role="alert" className="text-danger-text">
          {state.message}
        </p>
      )}
      {state.status === "ready" &&
        (state.sql === "" ? (
          <p ref={(el) => void (body.current = el)} tabIndex={0} className={`rounded-md ${ring}`}>
            {f.sqlNone}
          </p>
        ) : (
          <>
            <pre
              ref={(el) => void (body.current = el)}
              tabIndex={0}
              className={`max-h-48 overflow-auto rounded-md border border-pill-border bg-search p-2 font-mono text-sm whitespace-pre-wrap select-text ${ring}`}
            >
              {state.sql}
            </pre>
            <p className="text-text-2">{f.sqlParams}</p>
          </>
        ))}
      <div className="flex items-center justify-end gap-2">
        <span role="status" className="mr-auto text-text-2">
          {copy === "copied" ? f.sqlCopied : copy === "failed" ? f.sqlCopyFailed : ""}
        </span>
        {state.status === "ready" && state.sql !== "" && (
          <button type="button" className={popoverButton} onClick={() => void doCopy(state.sql)}>
            {f.sqlCopy}
          </button>
        )}
        <button type="button" className={popoverButton} onClick={() => onClose(true)}>
          {f.sqlClose}
        </button>
      </div>
    </div>
  );
}
