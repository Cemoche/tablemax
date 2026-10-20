import { ArrowLeft, Link, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toConnectionUrl } from "../../lib/connectionUrl";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
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
import { ConnectPrompt } from "./ConnectPrompt";
import {
  blankConnection,
  driverPatch,
  forBackend,
  normalize,
  errorText,
  sslModePicked,
  withSslMode,
  withUrlImport,
} from "./connectionDraft";
import { DriverTile } from "./DriverTile";
import {
  buttonClass,
  fieldClass,
  formClass,
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
  /** Pre-filled DB password for an unsaved connection (from a pasted URL). */
  initialPassword?: string | null;
  /** The pre-filled unsaved connection's SSL mode came from its URL, not from a default. */
  sslExplicit?: boolean;
  /** Called with the saved config and the typed DB / SSH secrets (null when untouched). */
  onConnect: (cfg: ConnectionConfig, password: string | null, sshSecret: string | null) => void;
  onSaved?: (cfg: ConnectionConfig) => void;
  onDeleted?: (id: string) => void;
  /** The header's back button: the connection list. */
  onClose?: () => void;
}

type Notice = { tone: "ok" | "error"; text: string } | null;

/** The engines the form offers (MongoDB has its own form, on its own branch). */
const DRIVERS = ["postgres", "mySql", "mariaDb", "sqlite"] as const;
const TAGS = ["local", "dev", "staging", "prod"] as const;

/**
 * The compact connection form (spec §2.4, §5.2): 620 px wide, labels right-aligned in a
 * 104 px column, 28 px lines in the order name ; colour + tag ; safe mode ; host + port ;
 * user ; password + storage ; database ; SSL mode + CA… / Cert… / Key… ; the Over SSH box ;
 * then Import from URL… / Test / Save / Connect. PostgreSQL and MySQL without SSH fit a
 * 900 px window without scrolling (ConnectionForm.test.tsx). Typed secrets go to the
 * backend (keyring) on Save / Connect / Test only.
 */
export function ConnectionForm({
  connection,
  initialPassword = null,
  sslExplicit = false,
  onConnect,
  onSaved,
  onDeleted,
  onClose,
}: Props) {
  const [cfg, setCfg] = useState<ConnectionConfig>(normalize(connection ?? blankConnection()));
  const [password, setPassword] = useState(initialPassword ?? "");
  const [sshSecret, setSshSecret] = useState("");
  /**
   * The SSL mode follows host and SSH (defaultSslMode) until the user picks one. A
   * loaded connection keeps a non-default mode, and a URL draft a mode its URL stated.
   */
  const [sslPicked, setSslPicked] = useState(sslModePicked(connection, sslExplicit));
  const [busy, setBusy] = useState<"test" | "save" | "connect" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [urlDialog, setUrlDialog] = useState(false);
  const items = useConnections((s) => s.items);
  const save = useConnections((s) => s.save);
  const remove = useConnections((s) => s.remove);
  const colorName = `${useId()}-color`;

  useEffect(() => {
    setCfg(normalize(connection ?? blankConnection()));
    setPassword(initialPassword ?? "");
    setSshSecret("");
    setSslPicked(sslModePicked(connection, sslExplicit));
    setNotice(null);
    // initialPassword travels with `connection`; it must not reset typed input alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

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

  const stored = connection?.id ? connection.ssh : null;
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

  // Import from URL…: the URL's fields over the draft (the connection keeps its name,
  // colour, tag, group and safe mode); its password is typed in, saved with the connection.
  const onUrlResult = (imported: Partial<ConnectionConfig>, urlPassword: string | null, explicit: boolean) => {
    const next = normalize(withUrlImport(cfg, imported));
    setCfg(next);
    setPassword(urlPassword ?? "");
    setSshSecret("");
    setSslPicked(sslModePicked(next, explicit));
    setNotice(null);
    setUrlDialog(false);
  };

  return (
    <>
      <form data-connection-form="" onSubmit={(e) => e.preventDefault()} className={formClass}>
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
              type="button"
              className={`${iconButtonClass} text-danger`}
              aria-label={strings.form.delete}
              {...tip(strings.form.delete)}
              disabled={busy !== null}
              onClick={onDelete}
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
            <input id="cf-name" className={fieldClass} value={cfg.name} onChange={(e) => patch({ name: e.target.value })} />
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
            className={`flex min-h-7 items-center text-sm ${notice.tone === "ok" ? "text-success" : "text-danger"}`}
          >
            {notice.text}
          </p>
        )}

        <div className="flex h-8 items-end gap-2">
          <button type="button" className={buttonClass} onClick={() => setUrlDialog(true)}>
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
      {urlDialog && <UrlImportDialog onCancel={() => setUrlDialog(false)} onResult={onUrlResult} />}
      <ConnectPrompt flow={testFlow} connectionName={testFlow.context?.name || strings.form.newTitle} />
    </>
  );
}
