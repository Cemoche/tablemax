import { type FormEvent, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { strings } from "../../lib/strings";
import { LIMIT_MAX, LIMIT_MIN } from "./usePagedTable";

const p = strings.grid.pagePopover;

/** The popovers of the bottom bar: above their trigger, the bar's look. */
export const popoverBox =
  "absolute bottom-full z-30 mb-1.5 rounded-lg border border-pill-border bg-pill p-2 text-sm text-text shadow-lg outline-none";
export const popoverField =
  "h-6 w-28 rounded-md border border-pill-border bg-search px-1.5 text-right font-mono text-sm text-text outline-none focus-visible:focus-ring-inset aria-invalid:border-danger";
export const popoverButton =
  "flex h-6 items-center justify-center rounded-md border border-pill-border bg-btn px-3 text-sm text-text outline-none hover:bg-seg-sel focus-visible:focus-ring disabled:text-icon-dim disabled:hover:bg-btn";

/**
 * Escape and a press outside the popover (and its trigger, the `aria-haspopup="dialog"`
 * button next to it, which toggles it itself) close it. `refocus`: give the focus back to
 * the trigger (Escape, a choice), not after a press elsewhere.
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, onClose: (refocus: boolean) => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (!ref.current?.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      close.current(true);
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      const trigger = ref.current?.parentElement?.querySelector('[aria-haspopup="dialog"]');
      if (target && (ref.current?.contains(target) || trigger?.contains(target))) return;
      close.current(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [ref]);
}

/** A whole number typed with optional thousands separators (`1,250`, `1 250`), else null. */
function wholeNumber(text: string): number | null {
  const t = text.trim().replace(/[ _,]/g, "");
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

interface Props {
  offset: number;
  limit: number;
  /** False when refused (changes pending): the popover stays. */
  onGo: (offset: number, limit: number) => boolean;
  onClose: (refocus: boolean) => void;
}

/** Offset and limit of the page, with Go (Enter). Not modal. */
export function PagePopover({ offset, limit, onGo, onClose }: Props) {
  const ref = useRef<HTMLFormElement>(null);
  const offsetRef = useRef<HTMLInputElement>(null);
  const [offsetText, setOffsetText] = useState(String(offset));
  const [limitText, setLimitText] = useState(String(limit));
  const [error, setError] = useState<{ field: "offset" | "limit"; text: string } | null>(null);
  const errorId = useId();
  useDismiss(ref, onClose);
  useEffect(() => {
    offsetRef.current?.focus();
    offsetRef.current?.select();
  }, []);

  const go = (e: FormEvent) => {
    e.preventDefault();
    const o = wholeNumber(offsetText);
    if (o === null) return setError({ field: "offset", text: p.offsetInvalid });
    const l = wholeNumber(limitText);
    if (l === null || l < LIMIT_MIN || l > LIMIT_MAX) {
      return setError({ field: "limit", text: p.limitInvalid(LIMIT_MIN, LIMIT_MAX) });
    }
    setError(null);
    if (onGo(o, l)) onClose(true);
  };

  const row = (label: string, input: ReactNode) => (
    <label className="flex items-center justify-between gap-3">
      <span className="text-text-2">{label}</span>
      {input}
    </label>
  );
  return (
    <form
      ref={ref}
      role="dialog"
      aria-label={p.label}
      className={`${popoverBox} right-0 flex w-60 flex-col gap-1.5`}
      onSubmit={go}
      noValidate
    >
      {row(
        p.offset,
        <input
          ref={offsetRef}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          aria-invalid={error?.field === "offset" || undefined}
          aria-describedby={error?.field === "offset" ? errorId : undefined}
          className={popoverField}
          value={offsetText}
          onChange={(e) => setOffsetText(e.target.value)}
        />,
      )}
      {row(
        p.limit,
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          aria-invalid={error?.field === "limit" || undefined}
          aria-describedby={error?.field === "limit" ? errorId : undefined}
          className={popoverField}
          value={limitText}
          onChange={(e) => setLimitText(e.target.value)}
        />,
      )}
      {error && (
        <p id={errorId} role="alert" className="text-danger-text">
          {error.text}
        </p>
      )}
      <button type="submit" className={`${popoverButton} self-end`}>
        {p.go}
      </button>
    </form>
  );
}
