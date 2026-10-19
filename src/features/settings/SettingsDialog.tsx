import { useEffect, useId, useRef, useState } from "react";
import * as ipc from "../../lib/ipc";
import { DEFAULT_KEYMAP, KEYMAP_ACTIONS, type KeymapActionId, conflictAnywhere, effectiveShortcut, isValidShortcut, sameCombination } from "../../lib/keymap";
import { strings } from "../../lib/strings";
import { useRestoreFocus } from "../../lib/useRestoreFocus";
import type { Settings, ThemeSetting } from "../../lib/types";
import { useSettings } from "../../stores/settings";
import { type NumericSettingKey, SETTINGS_BOUNDS, isValidFontFamily, parseBounded } from "./bounds";
import { formatShortcut, isMac } from "../../lib/platform";

const input = "rounded-sm border border-border bg-bg px-2 py-1";
const FOCUSABLE = 'button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])';

const THEMES: { value: ThemeSetting; label: string }[] = [
  { value: "system", label: strings.settings.themeSystem },
  { value: "light", label: strings.settings.themeLight },
  { value: "dark", label: strings.settings.themeDark },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Integer field: typing only edits a draft; Enter or blur saves it when it is a whole number
 * within the bounds. An invalid draft shows an inline error, saves nothing and is kept on blur
 * so it can be fixed. Escape reverts the draft (and does not close the dialog).
 */
function NumberField({ field, label }: { field: NumericSettingKey; label: string }) {
  const value = useSettings((s) => s.settings[field]);
  const update = useSettings((s) => s.update);
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const { min, max } = SETTINGS_BOUNDS[field];
  const text = draft ?? String(value);
  const invalid = draft !== null && parseBounded(field, draft) === null;
  const commit = () => {
    if (draft === null) return;
    const n = parseBounded(field, draft);
    if (n === null) return;
    setDraft(null);
    if (n !== value) void update({ [field]: n } as Partial<Settings>);
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-muted">
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        className={`${input} w-40 ${invalid ? "border-danger" : ""}`}
        value={text}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape" && draft !== null) {
            // Reverts the draft only; the dialog's own Escape (on the document) must not fire.
            e.stopPropagation();
            setDraft(null);
          }
        }}
        onBlur={commit}
      />
      {invalid && (
        <p id={`${id}-error`} className="text-danger">
          {strings.settings.range(min, max)}
        </p>
      )}
    </div>
  );
}

/**
 * Font family: edited as a draft and saved on Enter or blur, only when it matches the safe
 * font grammar; invalid or half-typed text (`"Fira`) shows an inline error and is never sent.
 */
function FontFamilyField() {
  const value = useSettings((s) => s.settings.editorFontFamily);
  const update = useSettings((s) => s.update);
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const text = draft ?? value;
  const invalid = draft !== null && !isValidFontFamily(draft.trim());
  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    if (!isValidFontFamily(next)) return;
    setDraft(null);
    if (next !== value) void update({ editorFontFamily: next });
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-muted">
        {strings.settings.fontFamily}
      </label>
      <input
        id={id}
        type="text"
        className={`${input} ${invalid ? "border-danger" : ""}`}
        value={text}
        placeholder={strings.settings.fontFamilyPlaceholder}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        onBlur={commit}
      />
      {invalid && (
        <p id={`${id}-error`} className="text-danger">
          {strings.settings.fontFamilyInvalid}
        </p>
      )}
    </div>
  );
}

const KEY_CODES: Record<string, string> = {
  Slash: "/",
  Period: ".",
  Comma: ",",
  Semicolon: ";",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Backquote: "`",
};
const NAMED_CODES = new Set([
  "Enter", "Tab", "Escape", "Space", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);
const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)$/;

/**
 * The canonical spec of a keydown ("Mod+Shift+K"), built from `e.code` so it does not depend
 * on the layout; Mod is Ctrl on Linux/Windows and Meta on macOS (Ctrl stays Ctrl there).
 * A key with no name in the grammar yields a spec without a key (the caller reports it as invalid).
 */
function specFromEvent(e: KeyboardEvent, mac: boolean): string {
  const code = e.code;
  let key = "";
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(code) || NAMED_CODES.has(code)) key = code;
  else if (Object.prototype.hasOwnProperty.call(KEY_CODES, code)) key = KEY_CODES[code];
  const mods: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) mods.push("Mod");
  if (mac ? e.ctrlKey : false) mods.push("Ctrl");
  if (!mac && e.metaKey) mods.push("Meta");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, key].join("+");
}

function KeyboardRow({ id, label }: { id: KeymapActionId; label: string }) {
  const keymap = useSettings((s) => s.settings.keymap);
  const update = useSettings((s) => s.update);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keymapRef = useRef(keymap);
  keymapRef.current = keymap;
  const overridden = Object.prototype.hasOwnProperty.call(keymap, id) && !sameCombination(effectiveShortcut(id, keymap), DEFAULT_KEYMAP[id]);

  useEffect(() => {
    if (!recording) return;
    // Capture phase on the document: nothing else (the dialog's Escape, global shortcuts) sees the key.
    const onKey = (e: KeyboardEvent) => {
      if (MODIFIER_CODES.test(e.code) || e.key === "Dead" || e.key === "Process") return;
      const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      if (e.code === "Tab" && bare) {
        setRecording(false); // focus navigation: let the browser move on
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (e.code === "Escape" && bare) {
        setRecording(false);
        setError(null);
        return;
      }
      const spec = specFromEvent(e, isMac());
      if (!isValidShortcut(spec)) {
        setError(strings.settings.shortcutInvalid);
        return;
      }
      const current = keymapRef.current;
      const other = conflictAnywhere(id, spec, current);
      if (other !== null) {
        setError(strings.settings.shortcutConflict(strings.keymap[other]));
        return;
      }
      setRecording(false);
      setError(null);
      if (sameCombination(spec, effectiveShortcut(id, current))) return;
      const next = { ...current };
      if (sameCombination(spec, DEFAULT_KEYMAP[id])) delete next[id];
      else next[id] = spec;
      void update({ keymap: next });
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [recording, id, update]);

  // Same rule as recording: the default comes back only if no other action uses it now.
  const reset = () => {
    const next = { ...keymap };
    delete next[id];
    const other = conflictAnywhere(id, DEFAULT_KEYMAP[id], next);
    if (other !== null) {
      setError(strings.settings.shortcutConflict(strings.keymap[other]));
      return;
    }
    setError(null);
    void update({ keymap: next });
  };

  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-4">
        <span>{label}</span>
        <span className="flex items-center gap-2">
          <kbd className="font-mono text-muted">{formatShortcut(effectiveShortcut(id, keymap))}</kbd>
          <button
            type="button"
            aria-label={strings.settings.changeShortcutFor(label)}
            className="rounded-sm border border-border px-2 py-0.5 hover:bg-surface-2"
            onClick={() => {
              setError(null);
              setRecording(true);
            }}
            onBlur={() => {
              setRecording(false);
              setError(null);
            }}
          >
            {recording ? strings.settings.recording : strings.settings.changeShortcut}
          </button>
          {overridden && (
            <button
              type="button"
              aria-label={strings.settings.resetShortcutFor(label)}
              className="rounded-sm border border-border px-2 py-0.5 hover:bg-surface-2"
              onClick={reset}
            >
              {strings.settings.resetShortcut}
            </button>
          )}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

/** Modal settings editor; valid changes are saved through the settings store (the font family and numbers on Enter or blur). */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  useRestoreFocus();
  const settings = useSettings((s) => s.settings);
  const error = useSettings((s) => s.error);
  const update = useSettings((s) => s.update);
  const [version, setVersion] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    closeRef.current?.focus();
    let live = true;
    ipc
      .appVersion()
      .then((v) => live && setVersion(v))
      .catch(() => {});
    // On the document so Escape works even when focus left the dialog.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      live = false;
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!dialogRef.current?.contains(active)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70" onKeyDown={onKeyDown}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="flex max-h-[85vh] w-[34rem] max-w-[90vw] flex-col gap-4 overflow-auto rounded-md border border-border bg-surface p-4 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <h2 id="settings-title" className="font-semibold">
            {strings.settings.title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="rounded-sm border border-border px-3 py-1 hover:bg-surface-2"
            onClick={onClose}
          >
            {strings.settings.close}
          </button>
        </div>
        {error && (
          <p role="alert" className="text-danger">
            {strings.settings.saveFailed(error)}
          </p>
        )}

        <Section title={strings.settings.appearance}>
          <fieldset className="flex items-center gap-4">
            <legend className="mb-1 text-muted">{strings.settings.theme}</legend>
            {THEMES.map((t) => (
              <label key={t.value} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="theme"
                  value={t.value}
                  checked={settings.theme === t.value}
                  onChange={() => void update({ theme: t.value })}
                />
                {t.label}
              </label>
            ))}
          </fieldset>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.useSystemTitleBar}
              aria-describedby="settings-system-title-bar-hint"
              onChange={(e) => void update({ useSystemTitleBar: e.target.checked })}
            />
            {strings.settings.systemTitleBar}
          </label>
          <p id="settings-system-title-bar-hint" className="text-sm text-muted">
            {strings.settings.systemTitleBarHint}
          </p>
        </Section>

        <Section title={strings.settings.editor}>
          <FontFamilyField />
          <NumberField field="editorFontSize" label={strings.settings.fontSize} />
        </Section>

        <Section title={strings.settings.data}>
          <NumberField field="pageSize" label={strings.settings.pageSize} />
          <NumberField field="exactCountThreshold" label={strings.settings.exactCount} />
        </Section>

        <Section title={strings.settings.queries}>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.autoLimitDefault}
              onChange={(e) => void update({ autoLimitDefault: e.target.checked })}
            />
            {strings.settings.autoLimit}
          </label>
          <NumberField field="autoLimitValue" label={strings.settings.autoLimitValue} />
        </Section>

        <Section title={strings.settings.keyboard}>
          <ul className="flex flex-col gap-1">
            {KEYMAP_ACTIONS.map((a) => (
              <KeyboardRow key={a.id} id={a.id} label={a.label} />
            ))}
          </ul>
        </Section>

        <Section title={strings.settings.about}>
          <p>
            {strings.settings.version}: {version ?? strings.settings.versionUnknown}
          </p>
          <p>{strings.settings.license}</p>
          <p>
            {strings.settings.repository}: {strings.settings.repositoryUrl}
          </p>
        </Section>
      </div>
    </div>
  );
}
