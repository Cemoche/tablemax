import { Check, Lock, LockOpen } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { toAppError } from "../../lib/errors";
import { defaultSafeMode, safeModeBannerText, safeModeLabel } from "../../lib/safeMode";
import { strings } from "../../lib/strings";
import { tip } from "../../lib/tooltip";
import type { SafeMode } from "../../lib/types";
import { useConnections } from "../../stores/connections";
import type { Workspace } from "../../stores/workspaces";
import { useLiveEnv } from "../workspace/useLiveEnv";
import { ICON, iconButton } from "./toolbarStyles";

const t = strings.toolbar;
/** null = Default (by tag), as in the connection form. */
const LEVELS: (SafeMode | null)[] = [null, "off", "confirmWrites", "confirmAll"];

/**
 * The safe mode button of the toolbar: its label is the mode the backend enforces on this
 * workspace (the stricter of the saved and the opened one); its menu sets the saved
 * connection's level, as the connection form does. Tightening applies at once, loosening
 * the next time the connection opens (unchanged safe mode rules).
 */
export function SafeModeMenu({ workspace }: { workspace: Workspace }) {
  const cfg = useConnections((s) => s.items.find((c) => c.id === workspace.connectionId));
  const { envTag, mode } = useLiveEnv(workspace);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const saved = cfg?.safeMode ?? null;
  const chosen = saved ?? defaultSafeMode(envTag);
  const label = t.safeMode(safeModeBannerText(mode));

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && (menu.current?.contains(target) || button.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (level: SafeMode | null) => {
    close(true);
    if (!cfg || level === saved) return;
    setError(null);
    useConnections
      .getState()
      .save({ ...cfg, safeMode: level }, null)
      .catch((e) => setError(strings.settings.saveFailed(toAppError(e).message)));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      go(at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      go(at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      go(0);
    } else if (e.key === "End") {
      e.preventDefault();
      go(items.length - 1);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  const Icon = mode === "off" ? LockOpen : Lock;
  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        aria-label={label}
        {...tip(error ?? label)}
        aria-describedby={error ? errorId : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!cfg}
        onClick={() => (open ? close(false) : setOpen(true))}
        className={`${iconButton} ${error ? "text-danger-text" : ""}`}
      >
        <Icon aria-hidden {...ICON} />
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label={t.safeModeMenu}
          onKeyDown={onKeyDown}
          className="absolute top-full left-0 z-50 mt-1.5 w-72 rounded-lg border border-pill-border bg-content p-1 text-sm text-text shadow-lg"
        >
          {LEVELS.map((level) => {
            const checked = level === saved;
            return (
              <button
                key={level ?? "default"}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                onClick={() => pick(level)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-seg-sel focus-visible:bg-seg-sel"
              >
                <Check aria-hidden size={14} className={checked ? "" : "invisible"} />
                {level === null ? strings.safety.defaultOption(safeModeLabel(defaultSafeMode(envTag))) : safeModeLabel(level)}
              </button>
            );
          })}
          {mode !== chosen && <p className="border-t border-pill-border px-2 pt-1.5 pb-1 text-text-2">{t.safeModeLater}</p>}
        </div>
      )}
      {/* Why the last save failed, read with the button (not only its tooltip). */}
      {error && (
        <span id={errorId} hidden>
          {error}
        </span>
      )}
      {error && !open && (
        <p role="alert" className="absolute top-full left-0 z-50 mt-1.5 w-72 rounded-md bg-content px-2 py-1 text-sm text-danger-text shadow-lg">
          {error}
        </p>
      )}
    </div>
  );
}
