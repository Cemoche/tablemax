import { useEffect, useRef } from "react";
import { safeModeBannerText } from "../../lib/safeMode";
import { strings } from "../../lib/strings";
import { useRestoreFocus } from "../../lib/useRestoreFocus";
import type { EnvTag, SafeMode } from "../../lib/types";
import { ENV_BG } from "../workspace/envClasses";

interface Props {
  connectionName: string;
  envTag: EnvTag;
  /** The mode the backend enforces (stricter of saved and opened, Ruling R16). */
  safeMode?: SafeMode;
  /** Every statement of the refused batch, in order. */
  statements: string[];
  /** Indices (into `statements`) the backend wants confirmed. */
  flagged: number[];
  onRun: () => void;
  onCancel: () => void;
}

const btn = "rounded-sm border border-border px-3 py-1 hover:bg-surface-2";

/** Modal shown when a protected connection refused an unconfirmed batch (nothing ran yet). */
export function ConfirmRunDialog({ connectionName, envTag, safeMode, statements, flagged, onRun, onCancel }: Props) {
  useRestoreFocus();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const runRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    cancelRef.current?.focus();
    // On the document so Escape cancels even when focus fell to the body (a click on the
    // overlay); stopped there so window listeners never see it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancelRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      // Keep focus inside the dialog: two buttons, so Tab just toggles between them.
      e.preventDefault();
      (document.activeElement === cancelRef.current ? runRef : cancelRef).current?.focus();
    }
  };

  const tag = envTag.toUpperCase();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70" onKeyDown={onKeyDown}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-run-title"
        className="flex max-h-[80vh] w-[40rem] max-w-[90vw] flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-lg"
      >
        <h2 id="confirm-run-title" className="flex items-center gap-2 font-semibold">
          <span aria-hidden className={`size-2 rounded-full ${ENV_BG[envTag]}`} />
          {strings.safety.dialogTitle}
        </h2>
        <p className="text-muted">{strings.safety.dialogIntro(connectionName, tag)}</p>
        {safeMode && <p className="text-muted">{strings.safety.bannerMode(safeModeBannerText(safeMode))}</p>}
        <ol className="flex min-h-0 flex-col gap-1 overflow-auto">
          {statements.map((s, i) => {
            const isFlagged = flagged.includes(i);
            return (
              <li
                key={i}
                data-flagged={isFlagged ? "true" : undefined}
                className={`rounded-sm border-l-4 px-2 py-1 ${
                  isFlagged ? "border-warning bg-warning/15" : "border-border bg-bg"
                }`}
              >
                <span className="text-muted">{strings.safety.statementLabel(i + 1)}</span>
                {isFlagged && <span className="ml-2 text-warning">{strings.safety.needsConfirmation}</span>}
                <pre className="mt-0.5 whitespace-pre-wrap break-words font-mono text-sm">{s}</pre>
              </li>
            );
          })}
        </ol>
        <div className="flex justify-end gap-2">
          <button ref={cancelRef} type="button" className={btn} onClick={onCancel}>
            {strings.safety.confirmCancel}
          </button>
          <button ref={runRef} type="button" className={`${btn} text-danger`} onClick={onRun}>
            {strings.safety.confirmRun}
          </button>
        </div>
      </div>
    </div>
  );
}
