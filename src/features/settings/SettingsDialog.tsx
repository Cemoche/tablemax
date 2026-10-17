import { useEffect, useId, useRef, useState } from "react";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { Settings, ThemeSetting } from "../../lib/types";
import { useSettings } from "../../stores/settings";
import { type NumericSettingKey, SETTINGS_BOUNDS, parseBounded } from "./bounds";
import { SHORTCUTS } from "./shortcuts";

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

/** Integer field: a valid value is saved at once, an invalid one shows an inline error and saves nothing. */
function NumberField({ field, label }: { field: NumericSettingKey; label: string }) {
  const value = useSettings((s) => s.settings[field]);
  const update = useSettings((s) => s.update);
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const { min, max } = SETTINGS_BOUNDS[field];
  const text = draft ?? String(value);
  const invalid = draft !== null && parseBounded(field, draft) === null;
  const change = (next: string) => {
    const n = parseBounded(field, next);
    if (n === null) {
      setDraft(next);
      return;
    }
    setDraft(null);
    void update({ [field]: n } as Partial<Settings>);
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
        onChange={(e) => change(e.target.value)}
        onBlur={() => setDraft(null)}
      />
      {invalid && (
        <p id={`${id}-error`} className="text-danger">
          {strings.settings.range(min, max)}
        </p>
      )}
    </div>
  );
}

/** Modal settings editor; every valid change is saved immediately through the settings store. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
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
        </Section>

        <Section title={strings.settings.editor}>
          <label className="flex flex-col gap-1">
            <span className="text-muted">{strings.settings.fontFamily}</span>
            <input
              type="text"
              className={input}
              value={settings.editorFontFamily}
              placeholder={strings.settings.fontFamilyPlaceholder}
              onChange={(e) => void update({ editorFontFamily: e.target.value })}
            />
          </label>
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
            {SHORTCUTS.map((s) => (
              <li key={s.keys} className="flex justify-between gap-4">
                <span>{s.label}</span>
                <kbd className="font-mono text-muted">{s.keys}</kbd>
              </li>
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
