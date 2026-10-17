import { useEffect, useState } from "react";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import {
  SWATCHES,
  type ConnectionConfig,
  type DriverKind,
  type EnvTag,
  type PasswordMode,
  type SslConfig,
} from "../../lib/types";
import { useConnections } from "../../stores/connections";
import { ConnectPrompt } from "./ConnectPrompt";
import {
  blankConnection,
  driverPatch,
  forBackend,
  normalize,
  errorText,
  withSslMode,
} from "./connectionDraft";
import { SshSection } from "./SshSection";
import { SslSection } from "./SslSection";
import { hostKeyLabel, useConnectFlow } from "./useConnectFlow";

interface Props {
  /** null = new connection. */
  connection: ConnectionConfig | null;
  /** Called with the saved config and the typed DB / SSH secrets (null when untouched). */
  onConnect: (cfg: ConnectionConfig, password: string | null, sshSecret: string | null) => void;
  onSaved?: (cfg: ConnectionConfig) => void;
  onDeleted?: (id: string) => void;
}

type Notice = { tone: "ok" | "error"; text: string } | null;

const field = "w-full rounded-sm border border-border bg-bg px-2 py-1";
const btn = "rounded-sm border border-border px-3 py-1 hover:bg-surface-2 disabled:opacity-50";

export function ConnectionForm({ connection, onConnect, onSaved, onDeleted }: Props) {
  const [cfg, setCfg] = useState<ConnectionConfig>(normalize(connection ?? blankConnection()));
  const [password, setPassword] = useState("");
  const [sshSecret, setSshSecret] = useState("");
  /** The SSL mode follows host and SSH (defaultSslMode) until the user picks one. */
  const [sslPicked, setSslPicked] = useState(!!connection?.id);
  const [busy, setBusy] = useState<"test" | "save" | "connect" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const save = useConnections((s) => s.save);
  const remove = useConnections((s) => s.remove);

  useEffect(() => {
    setCfg(normalize(connection ?? blankConnection()));
    setPassword("");
    setSshSecret("");
    setSslPicked(!!connection?.id);
    setNotice(null);
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
  const outgoing = () => forBackend(cfg, stored, typedSsh);

  const testFlow = useConnectFlow((s) =>
    ipc.connectionTest(outgoing(), s.password, s.sshSecret, s.acceptFingerprint),
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
      const version = await testFlow.start(initial, hostKeyLabel(cfg));
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

  return (
    <>
      <form
        onSubmit={(e) => e.preventDefault()}
        className="mx-auto flex w-full max-w-lg flex-col gap-3 p-5"
      >
        <h1 className="text-lg font-semibold">
          {isExisting ? strings.form.editTitle : strings.form.newTitle}
        </h1>

        <label className="flex flex-col gap-1">
          <span className="text-muted">{strings.form.name}</span>
          <input className={field} value={cfg.name} onChange={(e) => patch({ name: e.target.value })} />
        </label>

        <div className="flex items-center gap-2" role="group" aria-label={strings.form.color}>
          {SWATCHES.map((s, i) => (
            <button
              key={s}
              type="button"
              aria-label={strings.form.colorLabel(i + 1)}
              aria-pressed={cfg.color === s}
              onClick={() => patch({ color: s })}
              style={{ background: `var(--${s})` }}
              className={`size-5 rounded-full border-2 ${
                cfg.color === s ? "border-fg" : "border-transparent"
              }`}
            />
          ))}
        </div>

        <div className="flex gap-3">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-muted">{strings.form.env}</span>
            <select
              className={field}
              value={cfg.envTag}
              onChange={(e) => patch({ envTag: e.target.value as EnvTag })}
            >
              {(["local", "dev", "staging", "prod"] as const).map((t) => (
                <option key={t} value={t}>
                  {strings.env[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-muted">{strings.form.driver}</span>
            <select
              className={field}
              value={cfg.kind}
              onChange={(e) => setKind(e.target.value as DriverKind)}
            >
              {(["postgres", "mySql", "mariaDb", "sqlite"] as const).map((k) => (
                <option key={k} value={k}>
                  {strings.driver[k]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {isSqlite ? (
          <label className="flex flex-col gap-1">
            <span className="text-muted">{strings.form.sqlitePath}</span>
            <input
              className={`${field} font-mono`}
              value={cfg.sqlitePath ?? ""}
              onChange={(e) => patch({ sqlitePath: e.target.value || null })}
            />
          </label>
        ) : (
          <>
            <div className="flex gap-3">
              <div className="flex flex-[3] flex-col gap-1">
                <label htmlFor="cf-host" className="text-muted">
                  {strings.form.host}
                </label>
                <input
                  id="cf-host"
                  className={field}
                  value={cfg.host}
                  onChange={(e) => patch({ host: e.target.value })}
                />
              </div>
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-muted">{strings.form.port}</span>
                <input
                  type="number"
                  className={field}
                  value={cfg.port}
                  onChange={(e) => patch({ port: Number(e.target.value) })}
                />
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-muted">{strings.form.user}</span>
              <input className={field} value={cfg.user} onChange={(e) => patch({ user: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted">{strings.form.database}</span>
              <input
                className={field}
                value={cfg.database ?? ""}
                onChange={(e) => patch({ database: e.target.value || null })}
              />
            </label>
            <div className="flex gap-3">
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-muted">{strings.form.passwordMode}</span>
                <select
                  className={field}
                  value={cfg.passwordMode}
                  onChange={(e) => patch({ passwordMode: e.target.value as PasswordMode })}
                >
                  {(["keyring", "ask"] as const).map((m) => (
                    <option key={m} value={m}>
                      {strings.passwordMode[m]}
                    </option>
                  ))}
                </select>
              </label>
              {cfg.passwordMode === "keyring" && (
                <label className="flex flex-[2] flex-col gap-1">
                  <span className="text-muted">{strings.form.password}</span>
                  <input
                    type="password"
                    className={field}
                    autoComplete="off"
                    value={password}
                    placeholder={isExisting ? strings.form.passwordStored : ""}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
              )}
            </div>
            <SslSection
              kind={cfg.kind}
              host={cfg.host}
              overSsh={ssh !== null}
              ssl={cfg.ssl}
              onChange={setSsl}
            />
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
          <p role="status" className={notice.tone === "ok" ? "text-success" : "text-danger"}>
            {notice.text}
          </p>
        )}

        <div className="flex items-center gap-2">
          <button type="button" className={btn} disabled={busy !== null} onClick={onTest}>
            {busy === "test" ? strings.form.testing : strings.form.test}
          </button>
          <button type="button" className={btn} disabled={busy !== null} onClick={onSave}>
            {strings.form.save}
          </button>
          <button
            type="button"
            className="rounded-sm bg-accent px-3 py-1 text-accent-contrast disabled:opacity-50"
            disabled={busy !== null}
            onClick={onConnectClick}
          >
            {strings.form.connect}
          </button>
          {isExisting && (
            <button type="button" className={`${btn} ml-auto text-danger`} disabled={busy !== null} onClick={onDelete}>
              {strings.form.delete}
            </button>
          )}
        </div>
      </form>
      <ConnectPrompt flow={testFlow} connectionName={cfg.name || strings.form.newTitle} />
    </>
  );
}
