import { ArrowLeft, Link, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toConnectionUrl } from "../../lib/connectionUrl";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { isModalOpen } from "../../lib/shortcuts";
import { strings } from "../../lib/strings";
import { tip } from "../../lib/tooltip";
import {
  SWATCHES,
  type ConnectionConfig,
  type DriverKind,
  type EnvTag,
  type PasswordMode,
  type SslConfig,
} from "../../lib/types";
import { useConnections } from "../../stores/connections";
import { dotClass } from "../chrome/swatch";
import { ConfirmDialog } from "../workspace/ConfirmDialog";
import { ConnectPrompt } from "./ConnectPrompt";
import {
  blankConnection,
  driverPatch,
  forBackend,
  normalize,
  errorText,
  rebaseDraft,
  sameDraft,
  sslModePicked,
  withSslMode,
  withUrlImport,
} from "./connectionDraft";
import { DriverTile } from "./DriverTile";
import {
  buttonClass,
  fieldClass,
  formClass,
  iconButtonBaseClass,
  iconButtonClass,
  inlineLabelClass,
  labelClass,
  primaryButtonClass,
  rowClass,
} from "./formStyles";
import { SafetySection } from "./SafetySection";
import { SshSection } from "./SshSection";
import { SslSection } from "./SslSection";
import { UrlImportDialog } from "./UrlImportDialog";
import { flowTarget, useConnectFlow } from "./useConnectFlow";

interface Props {
  /** null = new connection. */
  connection: ConnectionConfig | null;
  /** Called with the saved config and the typed DB / SSH secrets (null when untouched). */
  onConnect: (cfg: ConnectionConfig, password: string | null, sshSecret: string | null) => void;
  onSaved?: (cfg: ConnectionConfig) => void;
  onDeleted?: (id: string) => void;
  /** The header's back button, and Escape: the connection list. */
  onClose?: () => void;
  /**
   * Whether the form holds unsaved edits: the draft differs from what was loaded (or last
   * saved), or a password or SSH secret is typed. The app asks before dropping them.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * False while the form is kept, hidden, behind a workspace: its dialogs (URL import,
   * Delete, the Test prompts) wait until it is on screen again, and Escape is not its.
   * Default true.
   */
  active?: boolean;
}

type Notice = { tone: "ok" | "error"; text: string } | null;

/** The engines the form offers (MongoDB has its own form, on its own branch). */
const DRIVERS = ["postgres", "mySql", "mariaDb", "sqlite"] as const;
const TAGS = ["local", "dev", "staging", "prod"] as const;

/** A text field with a suggestion list (`list` naming a datalist with options): Group, SSH host. */
function suggests(el: EventTarget | null): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) return false;
  const id = el.getAttribute("list");
  return id !== null && document.getElementById(id)?.querySelector("option") != null;
}

/**
 * The compact connection form (spec §2.4, §5.2): 620 px wide, labels right-aligned in a
 * 104 px column, 28 px lines in the order name ; colour + tag ; safe mode ; host + port ;
 * user ; password + storage ; database ; SSL mode + CA… / Cert… / Key… ; the Over SSH box ;
 * then Import from URL… / Test / Save / Connect. PostgreSQL and MySQL without SSH fit a
 * 900 px window without scrolling (ConnectionForm.test.tsx). Typed secrets go to the
 * backend (keyring) on Save / Connect / Test only. On mount the focus goes to Name for a
 * saved connection, to Driver for a new one. Escape closes it like ← (`onClose`, #118).
 */
export function ConnectionForm({
  connection,
  onConnect,
  onSaved,
  onDeleted,
  onClose,
  onDirtyChange,
  active = true,
}: Props) {
  const [cfg, setCfg] = useState<ConnectionConfig>(normalize(connection ?? blankConnection()));
  /** What the draft is compared with to tell unsaved edits: as loaded, or as last saved. */
  const [baseline, setBaseline] = useState<ConnectionConfig>(cfg);
  const [password, setPassword] = useState("");
  const [sshSecret, setSshSecret] = useState("");
  /**
   * The SSL mode follows host and SSH (defaultSslMode) until the user picks one. A
   * loaded connection keeps a non-default mode, and a URL import a mode its URL stated.
   */
  const [sslPicked, setSslPicked] = useState(sslModePicked(connection, false));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const firstField = useRef<HTMLElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<"test" | "save" | "connect" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [urlDialog, setUrlDialog] = useState(false);
  const urlButton = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  /**
   * The field whose suggestion list may be open: the webview shows it on typing, ↓ / ↑ or a
   * click, and closes it on Escape in its default action, after the page's listeners. No
   * API tells whether it is open, so its first Escape is left to it (one Escape too many when
   * nothing matched); Enter, Escape and leaving the field end it.
   */
  const suggesting = useRef<HTMLInputElement | null>(null);
  const items = useConnections((s) => s.items);
  const save = useConnections((s) => s.save);
  const remove = useConnections((s) => s.remove);
  const colorName = `${useId()}-color`;

  useEffect(() => {
    const loaded = normalize(connection ?? blankConnection());
    setCfg(loaded);
    setBaseline(loaded);
    setPassword("");
    setSshSecret("");
    setSslPicked(sslModePicked(connection, false));
    setNotice(null);
  }, [connection]);

  useEffect(() => firstField.current?.focus(), []);

  // Escape closes the form like ←, through the app's discard question (#118): the form's own
  // Escape, as a dialog's, so a text field does not keep it. A window listener, not the
  // form's onKeyDown: after a dialog, a disabled button or a click on the page the focus is
  // on the body, and Escape must still close the form. Not taken: another region's keys
  // (focus outside the form), a dialog's (`isModalOpen`; the form's dialogs and the app's
  // discard question handle their Escape), a shown tooltip's (TooltipLayer stops it first,
  // in the capture phase), an IME composition's, a suggestion list's; never while hidden
  // behind a workspace. A native select's open popup and the native file picker take the
  // key before the page.
  const close = useRef(onClose);
  close.current = onClose;
  const closable = onClose !== undefined;
  useEffect(() => {
    if (!active || !closable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.repeat || e.isComposing) return;
      if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || isModalOpen()) return;
      const t = e.target;
      const inForm = t instanceof Node && formRef.current?.contains(t) === true;
      if (!inForm && t !== document.body && t !== document.documentElement && t !== document) return;
      if (t !== null && t === suggesting.current) {
        suggesting.current = null;
        return;
      }
      e.preventDefault();
      close.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, closable]);

  // The connection may change in the store behind the form (the toolbar's safe mode menu
  // while the form waits behind a workspace): a clean draft takes the stored settings, an
  // edited one keeps its edits over them. Saving must never revert such a change.
  const storedCfg = useConnections((s) => (cfg.id ? s.items.find((c) => c.id === cfg.id) : undefined));
  useEffect(() => {
    if (!storedCfg) return;
    const next = normalize(storedCfg);
    if (sameDraft(next, baseline)) return;
    setCfg((c) => (sameDraft(c, baseline) ? next : rebaseDraft(c, baseline, next)));
    setBaseline(next);
    // Only a change of the stored connection; baseline and draft are read as they are now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedCfg]);

  const dirty = !sameDraft(cfg, baseline) || password !== "" || sshSecret !== "";
  const dirtyChange = useRef(onDirtyChange);
  dirtyChange.current = onDirtyChange;
  useEffect(() => dirtyChange.current?.(dirty), [dirty]);

  const patch = (p: Partial<ConnectionConfig>) => setCfg((c) => withSslMode({ ...c, ...p }, sslPicked));
  const setSsl = (ssl: SslConfig) => {
    if (ssl.mode !== cfg.ssl.mode) setSslPicked(true);
    setCfg((c) => ({ ...c, ssl }));
  };
  const isSqlite = cfg.kind === "sqlite";
  const typed = !isSqlite && cfg.passwordMode === "keyring" && password !== "" ? password : null;
  const ssh = isSqlite ? null : cfg.ssh;
  const typedSsh =
    ssh && ssh.auth !== "agent" && ssh.secretMode === "keyring" && sshSecret !== "" ? sshSecret : null;
  const isExisting = cfg.id !== "";

  /** The saved SSH settings (to tell a stored secret), as saved now. */
  const stored = storedCfg ? storedCfg.ssh : connection?.id ? connection.ssh : null;
  const outgoing = () => forBackend({ ...cfg, group: cfg.group?.trim() || null }, stored, typedSsh);

  const groups = [...new Set(items.map((c) => c.group?.trim()).filter((g): g is string => !!g))].sort(
    (a, b) => a.localeCompare(b),
  );

  const onCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(toConnectionUrl(cfg));
      setNotice({ tone: "ok", text: strings.form.urlCopied });
    } catch {
      setNotice({ tone: "error", text: strings.form.urlCopyFailed });
    }
  };

  const testFlow = useConnectFlow((s, config: ConnectionConfig) =>
    ipc.connectionTest(config, s.password, s.sshSecret, s.acceptFingerprint),
  );

  const fail = (e: unknown) => setNotice({ tone: "error", text: errorText(toAppError(e)) });

  const run = async <T,>(kind: "test" | "save" | "connect", fn: () => Promise<T>) => {
    setBusy(kind);
    setNotice(null);
    try {
      return await fn();
    } catch (e) {
      fail(e);
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const doSave = async () => {
    const saved = await save(outgoing(), typed, typedSsh);
    setCfg(normalize(saved));
    setBaseline(normalize(saved));
    setPassword("");
    setSshSecret("");
    onSaved?.(saved);
    return saved;
  };

  const onTest = () =>
    run("test", async () => {
      const initial = { password: typed, sshSecret: typedSsh, acceptFingerprint: null };
      const version = await testFlow.start(initial, outgoing(), flowTarget(cfg));
      if (version !== undefined) setNotice({ tone: "ok", text: strings.form.testOk(version) });
    });

  const onSave = () => {
    if (!cfg.name.trim()) return setNotice({ tone: "error", text: strings.form.nameRequired });
    return run("save", doSave);
  };

  const onConnectClick = async () => {
    if (!cfg.name.trim()) return setNotice({ tone: "error", text: strings.form.nameRequired });
    const saved = await run("connect", doSave);
    if (saved) onConnect(saved, typed, typedSsh);
  };

  const onDelete = () =>
    run("save", async () => {
      setConfirmDelete(false);
      await remove(cfg.id);
      onDeleted?.(cfg.id);
    });

  const setKind = (kind: DriverKind) => {
    if (kind === "sqlite") {
      setPassword("");
      setSshSecret("");
    }
    patch(driverPatch(cfg, kind));
  };

  /** The URL dialog closes with the focus back on its button. */
  const closeUrlDialog = () => {
    setUrlDialog(false);
    urlButton.current?.focus();
  };

  // Import from URL…: the URL's fields over the draft (the connection keeps its name,
  // colour, tag, group and safe mode); its password is typed in, saved with the connection.
  const onUrlResult = (imported: Partial<ConnectionConfig>, urlPassword: string | null, explicit: boolean) => {
    const next = normalize(withUrlImport(cfg, imported));
    setCfg(next);
    setPassword(urlPassword ?? "");
    setSshSecret("");
    setSslPicked(sslModePicked(next, explicit));
    setNotice(null);
    closeUrlDialog();
  };

  return (
    <>
      <form
        ref={formRef}
        data-connection-form=""
        onSubmit={(e) => e.preventDefault()}
        onInput={(e) => {
          if (suggests(e.target)) suggesting.current = e.target;
        }}
        onClick={(e) => {
          if (suggests(e.target)) suggesting.current = e.target;
        }}
        onKeyDown={(e) => {
          if (!suggests(e.target)) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") suggesting.current = e.target;
          else if (e.key === "Enter") suggesting.current = null;
        }}
        onBlur={(e) => {
          // React types a bubbled blur's target as the form itself: widened to compare.
          if (suggesting.current === (e.target as EventTarget)) suggesting.current = null;
        }}
        className={formClass}
      >
        <div className="flex h-10 items-center gap-3">
          <DriverTile kind={cfg.kind} />
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-text">
            {isExisting ? strings.form.editTitle : strings.form.newTitle}
          </h1>
          {isExisting && (
            <button
              type="button"
              className={iconButtonClass}
              aria-label={strings.form.copyUrl}
              {...tip(strings.form.copyUrl)}
              onClick={onCopyUrl}
            >
              <Link aria-hidden className="size-4" />
            </button>
          )}
          {isExisting && (
            <button
              ref={deleteButton}
              type="button"
              className={`${iconButtonBaseClass} text-danger-text`}
              aria-label={strings.form.delete}
              {...tip(strings.form.delete)}
              disabled={busy !== null}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 aria-hidden className="size-4" />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              className={iconButtonClass}
              aria-label={strings.connections.back}
              {...tip(strings.connections.back)}
              onClick={onClose}
            >
              <ArrowLeft aria-hidden className="size-4" />
            </button>
          )}
        </div>

        <div data-form-row="" className={rowClass}>
          <label htmlFor="cf-driver" className={labelClass}>
            {strings.form.driver}
          </label>
          <select
            id="cf-driver"
            ref={isExisting ? undefined : (el) => void (firstField.current = el)}
            className={fieldClass}
            value={cfg.kind}
            onChange={(e) => setKind(e.target.value as DriverKind)}
          >
            {DRIVERS.map((k) => (
              <option key={k} value={k}>
                {strings.driver[k]}
              </option>
            ))}
          </select>
        </div>

        <div data-form-row="" className={rowClass}>
          <label htmlFor="cf-name" className={labelClass}>
            {strings.form.name}
          </label>
          <div className="flex min-w-0 items-center gap-2">
            <input
              id="cf-name"
              ref={isExisting ? (el) => void (firstField.current = el) : undefined}
              className={fieldClass}
              value={cfg.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
            <label htmlFor="cf-group" className={inlineLabelClass}>
              {strings.form.group}
            </label>
            <input
              id="cf-group"
              className={`${fieldClass} w-40 shrink-0`}
              list="cf-groups"
              value={cfg.group ?? ""}
              placeholder={strings.form.groupPlaceholder}
              onChange={(e) => patch({ group: e.target.value || null })}
            />
            <datalist id="cf-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>
        </div>

        <div data-form-row="" className={rowClass}>
          <span id="cf-color-label" className={labelClass}>
            {strings.form.color}
          </span>
          <div className="flex min-w-0 items-center gap-2">
            <div role="radiogroup" aria-labelledby="cf-color-label" className="flex items-center gap-1.5">
              {SWATCHES.map((s, i) => (
                <label key={s} className="relative flex size-6 items-center justify-center" {...tip(strings.form.colorLabel(i + 1))}>
                  <input
                    type="radio"
                    name={colorName}
                    value={s}
                    aria-label={strings.form.colorLabel(i + 1)}
                    checked={cfg.color === s}
                    onChange={() => patch({ color: s })}
                    className="peer absolute inset-0 m-0 cursor-pointer opacity-0"
                  />
                  <span
                    aria-hidden
                    className={`size-4.5 rounded-full ring-offset-2 ring-offset-content peer-checked:ring-2 peer-checked:ring-text peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-accent ${dotClass(s)}`}
                  />
                </label>
              ))}
            </div>
            <span className="flex-1" />
            <label htmlFor="cf-tag" className={inlineLabelClass}>
              {strings.form.env}
            </label>
            <select
              id="cf-tag"
              className={`${fieldClass} w-40 shrink-0`}
              value={cfg.envTag}
              onChange={(e) => patch({ envTag: e.target.value as EnvTag })}
            >
              {TAGS.map((t) => (
                <option key={t} value={t}>
                  {strings.env[t]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <SafetySection value={cfg.safeMode} envTag={cfg.envTag} onChange={(safeMode) => patch({ safeMode })} />

        {isSqlite ? (
          <div data-form-row="" className={rowClass}>
            <label htmlFor="cf-sqlite-path" className={labelClass}>
              {strings.form.sqlitePath}
            </label>
            <input
              id="cf-sqlite-path"
              className={`${fieldClass} font-mono`}
              value={cfg.sqlitePath ?? ""}
              onChange={(e) => patch({ sqlitePath: e.target.value || null })}
            />
          </div>
        ) : (
          <>
            <div data-form-row="" className={rowClass}>
              <label htmlFor="cf-host" className={labelClass}>
                {strings.form.host}
              </label>
              <div className="flex min-w-0 items-center gap-2">
                <input id="cf-host" className={fieldClass} value={cfg.host} onChange={(e) => patch({ host: e.target.value })} />
                <label htmlFor="cf-port" className={inlineLabelClass}>
                  {strings.form.port}
                </label>
                <input
                  id="cf-port"
                  type="number"
                  className={`${fieldClass} w-24 shrink-0`}
                  value={cfg.port}
                  onChange={(e) => patch({ port: Number(e.target.value) })}
                />
              </div>
            </div>
            <div data-form-row="" className={rowClass}>
              <label htmlFor="cf-user" className={labelClass}>
                {strings.form.user}
              </label>
              <input id="cf-user" className={fieldClass} value={cfg.user} onChange={(e) => patch({ user: e.target.value })} />
            </div>
            <div data-form-row="" className={rowClass}>
              <label htmlFor={cfg.passwordMode === "keyring" ? "cf-password" : "cf-password-mode"} className={labelClass}>
                {strings.form.password}
              </label>
              <div className="flex min-w-0 items-center gap-2">
                {cfg.passwordMode === "keyring" && (
                  <input
                    id="cf-password"
                    type="password"
                    className={fieldClass}
                    autoComplete="off"
                    value={password}
                    placeholder={isExisting ? strings.form.passwordStored : ""}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                )}
                <select
                  id="cf-password-mode"
                  aria-label={strings.form.passwordMode}
                  className={`${fieldClass} ${cfg.passwordMode === "keyring" ? "w-44 shrink-0" : ""}`}
                  value={cfg.passwordMode}
                  onChange={(e) => patch({ passwordMode: e.target.value as PasswordMode })}
                >
                  {(["keyring", "ask"] as const).map((m) => (
                    <option key={m} value={m}>
                      {strings.passwordMode[m]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div data-form-row="" className={rowClass}>
              <label htmlFor="cf-database" className={labelClass}>
                {strings.form.database}
              </label>
              <input
                id="cf-database"
                className={fieldClass}
                value={cfg.database ?? ""}
                onChange={(e) => patch({ database: e.target.value || null })}
              />
            </div>
            <SslSection kind={cfg.kind} host={cfg.host} overSsh={ssh !== null} ssl={cfg.ssl} onChange={setSsl} />
            <SshSection
              ssh={ssh}
              stored={stored}
              onChange={(next) => patch({ ssh: next })}
              secret={sshSecret}
              onSecretChange={setSshSecret}
            />
          </>
        )}

        {notice && (
          <p
            role="status"
            className={`flex min-h-7 items-center text-sm ${notice.tone === "ok" ? "text-success" : "text-danger-text"}`}
          >
            {notice.text}
          </p>
        )}

        <div className="flex h-8 items-end gap-2">
          <button ref={urlButton} type="button" className={buttonClass} onClick={() => setUrlDialog(true)}>
            {strings.form.importUrl}
          </button>
          <span className="flex-1" />
          <button type="button" className={buttonClass} disabled={busy !== null} onClick={onTest}>
            {busy === "test" ? strings.form.testing : strings.form.test}
          </button>
          <button type="button" className={buttonClass} disabled={busy !== null} onClick={onSave}>
            {strings.form.save}
          </button>
          <button type="button" className={primaryButtonClass} disabled={busy !== null} onClick={onConnectClick}>
            {strings.form.connect}
          </button>
        </div>
      </form>
      {active && urlDialog && <UrlImportDialog onCancel={closeUrlDialog} onResult={onUrlResult} />}
      {active && confirmDelete && (
        <ConfirmDialog
          title={strings.connections.deleteTitle(cfg.name)}
          message={strings.connections.deleteMessage}
          confirmLabel={strings.connections.deleteOk}
          cancelLabel={strings.connections.deleteCancel}
          onConfirm={() => void onDelete()}
          onCancel={() => {
            setConfirmDelete(false);
            deleteButton.current?.focus();
          }}
        />
      )}
      {active && <ConnectPrompt flow={testFlow} connectionName={testFlow.context?.name || strings.form.newTitle} />}
    </>
  );
}
