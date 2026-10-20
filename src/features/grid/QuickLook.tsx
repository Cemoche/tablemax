import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { toAppError } from "../../lib/errors";
import { strings } from "../../lib/strings";
import type { CellValue } from "../../lib/types";
import { useRestoreFocus } from "../../lib/useRestoreFocus";
import { cellContent } from "./cellContent";
import { isTruncated } from "./editing";
import { prettyJson } from "./prettyJson";

/** What Quick Look shows of a value: the whole text, JSON indented; placeholders as such. */
export function quickLookText(v: CellValue | "default"): { text: string; placeholder: boolean } {
  const c = cellContent(v);
  if (c.placeholder) return { text: c.display, placeholder: true };
  if (v === "default") return { text: c.display, placeholder: true };
  switch (v.t) {
    case "json":
      return { text: prettyJson(v.v), placeholder: false };
    case "text": {
      // JSON kept in a text column reads better indented too (other text is left as is).
      const t = v.v.trimStart();
      return { text: t.startsWith("{") || t.startsWith("[") ? prettyJson(v.v) : v.v, placeholder: false };
    }
    case "longText":
      return { text: v.v.preview, placeholder: false };
    default:
      return { text: c.copyText, placeholder: false };
  }
}

interface Props {
  column: string;
  value: CellValue | "default";
  /** Loads the whole value of a truncated cell (a table row with a key); absent: none. */
  load?: () => Promise<CellValue>;
  onClose: () => void;
}

/**
 * Quick Look (Enter, or the cell menu): the whole value of a cell, read-only, JSON indented.
 * A modal dialog: Escape or Close closes it and the focus goes back to the grid.
 */
export function QuickLook({ column, value, load, onClose }: Props) {
  useRestoreFocus();
  const titleId = useId();
  const bodyRef = useRef<HTMLPreElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const truncated = value !== "default" && isTruncated(value);
  const [full, setFull] = useState<{ s: "loading" } | { s: "ready"; v: CellValue } | { s: "failed"; m: string } | null>(
    truncated && load ? { s: "loading" } : null,
  );
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    bodyRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!truncated || !loadRef.current) return;
    let live = true;
    loadRef.current().then(
      (v) => live && setFull({ s: "ready", v }),
      (e: unknown) => live && setFull({ s: "failed", m: toAppError(e).message }),
    );
    return () => {
      live = false;
    };
  }, [truncated]);

  const shown = quickLookText(full?.s === "ready" ? full.v : value);
  const note =
    full?.s === "loading"
      ? strings.grid.quickLook.loading
      : full?.s === "failed"
        ? strings.grid.quickLook.failed(full.m)
        : truncated && full === null
          ? strings.grid.quickLook.partial
          : null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      // Two stops: the value and Close.
      e.preventDefault();
      (document.activeElement === closeRef.current ? bodyRef : closeRef).current?.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70" onKeyDown={onKeyDown}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[70vh] w-[40rem] max-w-[90vw] flex-col gap-2 rounded-lg border border-pill-border bg-pill p-3 text-text shadow-lg"
      >
        <div className="flex items-center gap-2">
          <h2 id={titleId} className="min-w-0 flex-1 truncate font-semibold">
            {strings.grid.quickLook.title(column)}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-md border border-pill-border px-2 py-0.5 hover:bg-seg-sel focus-visible:outline-2 focus-visible:outline-accent"
          >
            {strings.grid.quickLook.close}
          </button>
        </div>
        {note && (
          <p role="status" className="text-sm text-text-2">
            {note}
          </p>
        )}
        <pre
          ref={bodyRef}
          tabIndex={0}
          aria-labelledby={titleId}
          className={`min-h-16 overflow-auto rounded-md border border-pill-border bg-content p-2 font-mono text-sm break-words whitespace-pre-wrap focus-visible:outline-2 focus-visible:outline-accent ${shown.placeholder ? "text-placeholder" : ""}`}
        >
          {shown.text}
        </pre>
      </div>
    </div>
  );
}
