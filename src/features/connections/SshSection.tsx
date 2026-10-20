import { useEffect, useState } from "react";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { PasswordMode, SshAuth, SshSettings } from "../../lib/types";
import { FileField } from "./FileField";
import { boxRowClass, fieldClass, inlineLabelClass, labelClass } from "./formStyles";

interface Props {
  ssh: SshSettings | null;
  /** The saved SSH settings, to tell whether a secret is stored in the keyring. */
  stored: SshSettings | null;
  onChange: (ssh: SshSettings | null) => void;
  /** Typed SSH password or key passphrase. */
  secret: string;
  onSecretChange: (secret: string) => void;
}

const NEW_SSH: SshSettings = {
  host: "",
  port: null,
  user: null,
  auth: "password",
  keyFile: null,
  secretMode: "keyring",
};

/** The agent has no secret; a password always needs one (no "none" storage). */
function withAuth(ssh: SshSettings, auth: SshAuth): SshSettings {
  const secretMode: PasswordMode =
    auth === "agent"
      ? "none"
      : ssh.auth === "agent" || (auth === "password" && ssh.secretMode === "none")
        ? "keyring"
        : ssh.secretMode;
  return { ...ssh, auth, secretMode };
}

/**
 * The "Over SSH" box of a network connection (not shown for SQLite): its checkbox opens
 * the tunnel's lines (host and port, user, authentication, key file, secret and its storage).
 */
export function SshSection({ ssh, stored, onChange, secret, onSecretChange }: Props) {
  const [aliases, setAliases] = useState<string[]>([]);
  const enabled = ssh !== null;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    ipc
      .sshHostsList()
      .then((hosts) => live && setAliases(hosts))
      .catch(() => {}); // suggestions only
    return () => {
      live = false;
    };
  }, [enabled]);

  const patch = (p: Partial<SshSettings>) => ssh && onChange({ ...ssh, ...p });
  const fromConfig = ssh !== null && aliases.includes(ssh.host) ? strings.ssh.fromConfig : undefined;
  const isKey = ssh?.auth === "key";
  const secretStored =
    stored !== null && stored.auth === ssh?.auth && stored.secretMode === "keyring";

  return (
    <div
      role="group"
      aria-label={strings.ssh.box}
      data-form-row=""
      className={`flex flex-col rounded-lg border border-sep px-2 ${enabled ? "gap-2 py-1.5" : "h-9 justify-center"}`}
    >
      <label className="flex h-7 items-center gap-2 text-text">
        <input
          type="checkbox"
          className="accent-accent"
          checked={enabled}
          onChange={(e) => {
            onSecretChange("");
            onChange(e.target.checked ? NEW_SSH : null);
          }}
        />
        {strings.ssh.enable}
      </label>
      {ssh && (
        <>
          <div className={boxRowClass}>
            <label htmlFor="cf-ssh-host" className={labelClass}>
              {strings.ssh.host}
            </label>
            <div className="flex min-w-0 items-center gap-2">
              <input
                id="cf-ssh-host"
                className={fieldClass}
                list="ssh-host-aliases"
                placeholder={strings.ssh.hostPlaceholder}
                value={ssh.host}
                onChange={(e) => patch({ host: e.target.value })}
              />
              <datalist id="ssh-host-aliases">
                {aliases.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
              <label htmlFor="cf-ssh-port" className={inlineLabelClass}>
                {strings.form.port}
              </label>
              <input
                id="cf-ssh-port"
                type="number"
                aria-label={strings.ssh.port}
                className={`${fieldClass} w-24 shrink-0`}
                placeholder={fromConfig ?? strings.ssh.defaultPort}
                value={ssh.port ?? ""}
                onChange={(e) => patch({ port: e.target.value === "" ? null : Number(e.target.value) })}
              />
            </div>
          </div>
          <div className={boxRowClass}>
            <label htmlFor="cf-ssh-user" className={labelClass}>
              {strings.ssh.user}
            </label>
            <input
              id="cf-ssh-user"
              className={fieldClass}
              placeholder={fromConfig}
              value={ssh.user ?? ""}
              onChange={(e) => patch({ user: e.target.value || null })}
            />
          </div>
          <div className={boxRowClass}>
            <label htmlFor="cf-ssh-auth" className={labelClass}>
              {strings.ssh.authShort}
            </label>
            <select
              id="cf-ssh-auth"
              aria-label={strings.ssh.auth}
              className={fieldClass}
              value={ssh.auth}
              onChange={(e) => {
                onSecretChange("");
                onChange(withAuth(ssh, e.target.value as SshAuth));
              }}
            >
              {(["password", "key", "agent"] as const).map((a) => (
                <option key={a} value={a}>
                  {strings.ssh.authModes[a]}
                </option>
              ))}
            </select>
          </div>
          {isKey && (
            <FileField
              id="ssh-key-file"
              label={strings.ssh.keyFileShort}
              name={strings.ssh.keyFile}
              purpose="sshKey"
              value={ssh.keyFile}
              placeholder={strings.ssh.keyFilePlaceholder}
              rowClass={boxRowClass}
              onChange={(keyFile) => patch({ keyFile })}
            />
          )}
          {ssh.auth !== "agent" && (
            <div className={boxRowClass}>
              <label
                htmlFor={ssh.secretMode === "keyring" ? "cf-ssh-secret" : "cf-ssh-secret-mode"}
                className={labelClass}
              >
                {isKey ? strings.ssh.passphrase : strings.form.password}
              </label>
              <div className="flex min-w-0 items-center gap-2">
                {ssh.secretMode === "keyring" && (
                  <input
                    id="cf-ssh-secret"
                    type="password"
                    aria-label={isKey ? strings.ssh.passphrase : strings.ssh.password}
                    className={fieldClass}
                    autoComplete="off"
                    value={secret}
                    placeholder={secretStored ? strings.form.passwordStored : ""}
                    onChange={(e) => onSecretChange(e.target.value)}
                  />
                )}
                <select
                  id="cf-ssh-secret-mode"
                  aria-label={strings.ssh.secretMode}
                  className={`${fieldClass} ${ssh.secretMode === "keyring" ? "w-44 shrink-0" : ""}`}
                  value={ssh.secretMode}
                  onChange={(e) => patch({ secretMode: e.target.value as PasswordMode })}
                >
                  <option value="keyring">{strings.passwordMode.keyring}</option>
                  <option value="ask">{strings.passwordMode.ask}</option>
                  {isKey && <option value="none">{strings.ssh.noPassphrase}</option>}
                </select>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
