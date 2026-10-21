import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import * as ipc from "../../lib/ipc";
import {
  KEYMAP_ACTIONS,
  type KeymapActionId,
  type ShortcutScope,
  conflictAnywhere,
  conflictFor,
  defaultShortcut,
  effectiveShortcut,
  effectiveShortcuts,
  isValidShortcut,
  sameCombination,
  useEffectiveShortcut,
} from "../../lib/keymap";
import { strings } from "../../lib/strings";
import { useRestoreFocus } from "../../lib/useRestoreFocus";
import type { Settings, ThemeSetting } from "../../lib/types";
import { useSettings } from "../../stores/settings";
import {
  INTERFACE_SCALE_PERCENTS,
  type NumericSettingKey,
  SETTINGS_BOUNDS,
  isValidFontFamily,
  parseBounded,
  scalePercent,
} from "./bounds";
import { formatShortcut, isMac } from "../../lib/platform";
import { keyPressOf } from "../../lib/shortcuts";

const S = strings.settings;
const focusRing = "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent";
const input = `h-7 rounded-md border border-pill-border bg-search px-2 text-text placeholder:text-text-2 aria-invalid:border-danger ${focusRing} focus-visible:-outline-offset-1`;
const button = `h-7 shrink-0 rounded-md border border-pill-border bg-btn px-3 text-text hover:bg-seg-sel ${focusRing}`;
const smallButton = `h-6 shrink-0 rounded-md border border-pill-border bg-btn px-2 text-sm text-text hover:bg-seg-sel ${focusRing}`;
const hint = "text-sm text-text-2";
const FOCUSABLE = 'button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])';

const THEMES: { value: ThemeSetting; label: string }[] = [
  { value: "system", label: S.themeSystem },
  { value: "light", label: S.themeLight },
  { value: "dark", label: S.themeDark },
];

type SectionId = keyof typeof S.sections;
const SECTIONS: SectionId[] = ["general", "table", "editor", "fonts", "keymap"];

/** The Keymap groups, in this order: where a shortcut acts. */
const SCOPES: ShortcutScope[] = ["global", "tableTab", "filterBar", "queryTab", "editor", "connectionList"];

/**
 * One line of a section: the label column (right-aligned; empty for a note under the line
 * above), then the control and its notes.
 */
function Row({
  label,
  labelFor,
  labelId,
  children,
}: {
  label?: string;
  labelFor?: string;
  labelId?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[11rem_minmax(0,1fr)] items-start gap-x-4">
      {label === undefined ? (
        <span aria-hidden="true" />
      ) : labelFor ? (
        <label htmlFor={labelFor} className="pt-1 text-right text-text-2">
          {label}
        </label>
      ) : (
        <span id={labelId} className="pt-1 text-right text-text-2">
          {label}
        </span>
      )}
      <div className="flex min-w-0 flex-col items-start gap-1">{children}</div>
    </div>
  );
}

/** A titled group of rows inside a section. */
function Group({ title, children }: { title?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={title ? id : undefined} className="flex flex-col gap-3">
      {title && (
        <h3 id={id} className="font-semibold">
          {title}
        </h3>
      )}
      {children}
    </section>
  );
}

/**
 * Integer field: typing only edits a draft; Enter or blur saves it when it is a whole number
 * within the bounds. An invalid draft shows an inline error, saves nothing and is kept on blur
 * so it can be fixed. Escape reverts the draft (and does not close the dialog).
 */
function NumberField({ field, label, describedBy }: { field: NumericSettingKey; label: string; describedBy?: string }) {
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
  const described = [invalid ? `${id}-error` : null, describedBy ?? null].filter(Boolean).join(" ");
  return (
    <Row label={label} labelFor={id}>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        className={`${input} w-36`}
        value={text}
        aria-invalid={invalid}
        aria-describedby={described || undefined}
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
        <p id={`${id}-error`} className="text-danger-text">
          {S.range(min, max)}
        </p>
      )}
    </Row>
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
    <Row label={S.fontFamily} labelFor={id}>
      <input
        id={id}
        type="text"
        className={`${input} w-full`}
        value={text}
        placeholder={S.fontFamilyPlaceholder}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        onBlur={commit}
      />
      {invalid && (
        <p id={`${id}-error`} className="text-danger-text">
          {S.fontFamilyInvalid}
        </p>
      )}
    </Row>
  );
}

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)$/;

/**
 * The canonical spec of a keydown ("Mod+Shift+K"), its key named as the shortcuts match it
 * (`keyPressOf`: the character the layout types when it names a shortcut, else the
 * position; Shift that typed a punctuation character is that character's, not a modifier);
 * Mod is Ctrl on Linux/Windows and Meta on macOS (Ctrl stays Ctrl there). A key with no
 * name in the grammar yields a spec without a key (the caller reports it as invalid).
 */
function specFromEvent(e: KeyboardEvent, mac: boolean): string {
  const { key, shift } = keyPressOf(e);
  const mods: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) mods.push("Mod");
  if (mac ? e.ctrlKey : false) mods.push("Ctrl");
  if (!mac && e.metaKey) mods.push("Meta");
  if (e.altKey) mods.push("Alt");
  if (shift) mods.push("Shift");
  return [...mods, key].join("+");
}

function KeyboardRow({ id, label }: { id: KeymapActionId; label: string }) {
  const keymap = useSettings((s) => s.settings.keymap);
  const update = useSettings((s) => s.update);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keymapRef = useRef(keymap);
  keymapRef.current = keymap;
  const overridden = Object.prototype.hasOwnProperty.call(keymap, id) && !sameCombination(effectiveShortcut(id, keymap), defaultShortcut(id));
  // A saved binding another action now uses as well (a default added later, #90): flagged,
  // never rewritten behind the user's back.
  const collision = overridden ? conflictFor(id, effectiveShortcut(id, keymap), keymap) : null;
  const combos = effectiveShortcuts(id, keymap);

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
        setError(S.shortcutInvalid);
        return;
      }
      const current = keymapRef.current;
      const other = conflictAnywhere(id, spec, current);
      if (other !== null) {
        setError(S.shortcutConflict(strings.keymap[other]));
        return;
      }
      setRecording(false);
      setError(null);
      if (sameCombination(spec, effectiveShortcut(id, current))) return;
      const next = { ...current };
      if (sameCombination(spec, defaultShortcut(id))) delete next[id];
      else next[id] = spec;
      void update({ keymap: next });
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [recording, id, update]);

  // Same rule as recording: the defaults (with the alternates) come back only if no other
  // action uses one of them now.
  const reset = () => {
    const next = { ...keymap };
    delete next[id];
    const other =
      effectiveShortcuts(id, {})
        .map((spec) => conflictAnywhere(id, spec, next))
        .find((o) => o !== null) ?? null;
    if (other !== null) {
      setError(S.shortcutConflict(strings.keymap[other]));
      return;
    }
    setError(null);
    void update({ keymap: next });
  };

  return (
    <li className="flex flex-col gap-1 py-1">
      <div className="flex items-center justify-between gap-4">
        <span className="min-w-0">{label}</span>
        <span className="flex items-center gap-2">
          <span className="flex flex-wrap justify-end gap-x-1 text-text-2">
            {combos.map((spec, i) => (
              <span key={spec}>
                <kbd className="font-mono">{formatShortcut(spec)}</kbd>
                {i < combos.length - 1 && S.shortcutListSeparator}
              </span>
            ))}
          </span>
          <button
            type="button"
            aria-label={S.changeShortcutFor(label)}
            className={smallButton}
            onClick={() => {
              setError(null);
              setRecording(true);
            }}
            onBlur={() => {
              setRecording(false);
              setError(null);
            }}
          >
            {recording ? S.recording : S.changeShortcut}
          </button>
          {overridden && (
            <button
              type="button"
              aria-label={S.resetShortcutFor(label)}
              className={smallButton}
              onClick={reset}
            >
              {S.resetShortcut}
            </button>
          )}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-danger-text">
          {error}
        </p>
      )}
      {collision && !error && (
        <p role="status" className="text-sm text-danger-text">
          {S.shortcutCollision(strings.keymap[collision])}
        </p>
      )}
    </li>
  );
}

/** Theme, interface size, font sizes and the editor font (spec §2.2). */
function FontsSection() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const themeId = useId();
  const sizeId = useId();
  const increase = formatShortcut(useEffectiveShortcut("font.increase"));
  const decrease = formatShortcut(useEffectiveShortcut("font.decrease"));
  return (
    <>
      <Group>
        <Row label={S.theme} labelId={`${themeId}-label`}>
          <div
            role="radiogroup"
            aria-labelledby={`${themeId}-label`}
            aria-describedby={`${themeId}-hint`}
            className="flex h-7 items-center gap-4"
          >
            {THEMES.map((t) => (
              <label key={t.value} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="theme"
                  value={t.value}
                  checked={settings.theme === t.value}
                  onChange={() => void update({ theme: t.value })}
                  className={focusRing}
                />
                {t.label}
              </label>
            ))}
          </div>
          <p id={`${themeId}-hint`} className={hint}>
            {S.themeSystemHint}
          </p>
        </Row>
        <Row label={S.interfaceSize} labelFor={sizeId}>
          <select
            id={sizeId}
            value={String(scalePercent(settings.interfaceScale) / 100)}
            aria-describedby={`${sizeId}-hint`}
            onChange={(e) => void update({ interfaceScale: Number(e.target.value) })}
            className={`${input} w-36`}
          >
            {INTERFACE_SCALE_PERCENTS.map((p) => (
              <option key={p} value={String(p / 100)}>
                {S.interfaceSizeOption(p)}
              </option>
            ))}
          </select>
          <p id={`${sizeId}-hint`} className={hint}>
            {S.interfaceSizeHint}
          </p>
        </Row>
      </Group>
      <Group>
        <NumberField field="dataFontSize" label={S.dataFontSize} describedBy={`${sizeId}-keys`} />
        <NumberField field="editorFontSize" label={S.editorFontSize} describedBy={`${sizeId}-keys`} />
        <Row>
          <p id={`${sizeId}-keys`} className={hint}>
            {S.fontSizeKeysHint(increase, decrease)}
          </p>
        </Row>
        <FontFamilyField />
      </Group>
    </>
  );
}

/** Every shortcut, grouped by where it acts; each can be changed or reset (spec §5.3). */
function KeymapSection() {
  return (
    <>
      {SCOPES.map((scope) => {
        const actions = KEYMAP_ACTIONS.filter((a) => a.scope === scope);
        if (actions.length === 0) return null;
        return <KeymapGroup key={scope} title={S.scopes[scope]} actions={actions} />;
      })}
    </>
  );
}

function KeymapGroup({ title, actions }: { title: string; actions: typeof KEYMAP_ACTIONS }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col">
      <h3 id={id} className="mb-1 font-semibold">
        {title}
      </h3>
      <ul className="flex flex-col divide-y divide-grid-sep">
        {actions.map((a) => (
          <KeyboardRow key={a.id} id={a.id} label={a.label} />
        ))}
      </ul>
    </div>
  );
}

function SectionContent({ section, version }: { section: SectionId; version: string | null }) {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  switch (section) {
    case "general":
      return (
        <>
          <Group>
            <Row label={S.window}>
              <label className="flex h-7 items-center gap-2">
                <input
                  type="checkbox"
                  checked={settings.useSystemTitleBar}
                  aria-describedby="settings-system-title-bar-hint"
                  onChange={(e) => void update({ useSystemTitleBar: e.target.checked })}
                  className={focusRing}
                />
                {S.systemTitleBar}
              </label>
              <p id="settings-system-title-bar-hint" className={hint}>
                {S.systemTitleBarHint}
              </p>
            </Row>
          </Group>
          <Group title={S.about}>
            <p>
              {S.version}: {version ?? S.versionUnknown}
            </p>
            <p>{S.license}</p>
            <p>
              {S.repository}: {S.repositoryUrl}
            </p>
          </Group>
        </>
      );
    case "table":
      return (
        <Group>
          <NumberField field="pageSize" label={S.pageSize} />
          <NumberField field="exactCountThreshold" label={S.exactCount} />
        </Group>
      );
    case "editor":
      return (
        <Group>
          <Row label={S.queries}>
            <label className="flex h-7 items-center gap-2">
              <input
                type="checkbox"
                checked={settings.autoLimitDefault}
                onChange={(e) => void update({ autoLimitDefault: e.target.checked })}
                className={focusRing}
              />
              {S.autoLimit}
            </label>
          </Row>
          <NumberField field="autoLimitValue" label={S.autoLimitValue} />
        </Group>
      );
    case "fonts":
      return <FontsSection />;
    case "keymap":
      return <KeymapSection />;
  }
}

/**
 * Modal settings editor (spec §2.2 / §5.3, Task 11): the sections on the left as a
 * vertical tablist (one Tab stop; ↑ / ↓, Home / End move and show), the selected one on
 * the right. Valid changes are saved through the settings store at once (the font family
 * and numbers on Enter or blur; the interface size zooms the window at once).
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  useRestoreFocus();
  const error = useSettings((s) => s.error);
  const [version, setVersion] = useState<string | null>(null);
  const [section, setSection] = useState<SectionId>("general");
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const domId = useId();
  const tabId = (s: SectionId) => `${domId}-tab-${s}`;
  const panelId = (s: SectionId) => `${domId}-panel-${s}`;

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

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab") return;
    // The hidden sections stay mounted (their drafts survive a switch): skip them.
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (el) => !el.closest("[hidden]"),
    );
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

  const onTabKeyDown = (e: ReactKeyboardEvent) => {
    const i = SECTIONS.indexOf(section);
    const next =
      e.key === "ArrowDown"
        ? SECTIONS[(i + 1) % SECTIONS.length]
        : e.key === "ArrowUp"
          ? SECTIONS[(i - 1 + SECTIONS.length) % SECTIONS.length]
          : e.key === "Home"
            ? SECTIONS[0]
            : e.key === "End"
              ? SECTIONS[SECTIONS.length - 1]
              : null;
    if (!next) return;
    e.preventDefault();
    setSection(next);
    document.getElementById(tabId(next))?.focus();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70" onKeyDown={onKeyDown}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="flex h-[min(36rem,85vh)] w-[46rem] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-pill-border bg-content text-text shadow-lg"
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-sep bg-win px-4">
          <h2 id="settings-title" className="font-semibold">
            {S.title}
          </h2>
          <button ref={closeRef} type="button" className={button} onClick={onClose}>
            {S.close}
          </button>
        </div>
        {error && (
          <p role="alert" className="shrink-0 border-b border-sep px-4 py-2 text-danger-text">
            {S.saveFailed(error)}
          </p>
        )}
        <div className="flex min-h-0 flex-1">
          <div
            role="tablist"
            aria-label={S.sectionsLabel}
            aria-orientation="vertical"
            className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-sep bg-side p-2"
          >
            {SECTIONS.map((s) => (
              <button
                key={s}
                id={tabId(s)}
                type="button"
                role="tab"
                aria-selected={section === s}
                aria-controls={panelId(s)}
                tabIndex={section === s ? 0 : -1}
                onClick={() => setSection(s)}
                onKeyDown={onTabKeyDown}
                className={`h-8 shrink-0 truncate rounded-md px-3 text-left hover:bg-seg-sel aria-selected:bg-sel aria-selected:font-medium ${focusRing} focus-visible:-outline-offset-2`}
              >
                {S.sections[s]}
              </button>
            ))}
          </div>
          {/* Every section stays mounted, the others hidden: a draft (even an invalid one,
              kept so it can be fixed) survives a switch. */}
          {SECTIONS.map((s) => (
            <div
              key={s}
              id={panelId(s)}
              role="tabpanel"
              aria-labelledby={tabId(s)}
              hidden={section !== s}
              className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-5"
            >
              <SectionContent section={s} version={version} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
