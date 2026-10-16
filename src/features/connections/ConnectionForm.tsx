import { useEffect, useState } from "react";
import { isPasswordRequired, toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import {
  SWATCHES,
  type ConnectionConfig,
  type DriverKind,
  type EnvTag,
  type PasswordMode,
} from "../../lib/types";
import { useConnections } from "../../stores/connections";

interface Props {
  /** null = new connection. */
  connection: ConnectionConfig | null;
  /** Called with the saved config and the typed password (null when untouched). */
  onConnect: (cfg: ConnectionConfig, password: string | null) => void;
  onSaved?: (cfg: ConnectionConfig) => void;
  onDeleted?: (id: string) => void;
}

const DEFAULT_PORT: Record<DriverKind, number> = {
  postgres: 5432,
  mySql: 3306,
  mariaDb: 3306,
  sqlite: 0,
};

const blank = (): ConnectionConfig => ({
  id: "",
  name: "",
  color: SWATCHES[0],
  envTag: "local",
  kind: "postgres",
  host: "localhost",
  port: 5432,
  user: "",
  database: null,
  sqlitePath: null,
  passwordMode: "keyring",
  group: null,
});

type Notice = { tone: "ok" | "error"; text: string } | null;

const field = "w-full rounded-sm border border-border bg-bg px-2 py-1";
const btn = "rounded-sm border border-border px-3 py-1 hover:bg-surface-2 disabled:opacity-50";

export function ConnectionForm({ connection, onConnect, onSaved, onDeleted }: Props) {
  const [cfg, setCfg] = useState<ConnectionConfig>(connection ?? blank());
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | "connect" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const save = useConnections((s) => s.save);
  const remove = useConnections((s) => s.remove);

  useEffect(() => {
    setCfg(connection ?? blank());
    setPassword("");
    setNotice(null);
  }, [connection]);

  const patch = (p: Partial<ConnectionConfig>) => setCfg((c) => ({ ...c, ...p }));
  const isSqlite = cfg.kind === "sqlite";
  const typed = cfg.passwordMode === "keyring" && password !== "" ? password : null;
  const isExisting = cfg.id !== "";

  const fail = (e: unknown) => {
    const err = toAppError(e);
    setNotice({
      tone: "error",
      text: isPasswordRequired(err) ? strings.form.passwordRequired : err.message,
    });
  };

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
    const saved = await save(cfg, typed);
    setCfg(saved);
    setPassword("");
    onSaved?.(saved);
    return saved;
  };

  const onTest = () =>
    run("test", async () => {
      const version = await ipc.connectionTest(cfg, typed);
      setNotice({ tone: "ok", text: strings.form.testOk(version) });
    });

  const onSave = () => {
    if (!cfg.name.trim()) return setNotice({ tone: "error", text: strings.form.nameRequired });
    return run("save", doSave);
  };

  const onConnectClick = async () => {
    if (!cfg.name.trim()) return setNotice({ tone: "error", text: strings.form.nameRequired });
    const pw = typed;
    const saved = await run("connect", doSave);
    if (saved) onConnect(saved, pw);
  };

  const onDelete = () =>
    run("save", async () => {
      await remove(cfg.id);
      onDeleted?.(cfg.id);
    });

  const setKind = (kind: DriverKind) => patch({ kind, port: DEFAULT_PORT[kind] || cfg.port });

  return (
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
                aria-describedby="cf-host-hint"
                className={field}
                value={cfg.host}
                onChange={(e) => patch({ host: e.target.value })}
              />
              <span id="cf-host-hint" className="text-xs text-muted">
                {strings.form.hostHint}
              </span>
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
  );
}
