import { useEffect, useState } from "react";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { PasswordMode, SshAuth, SshSettings } from "../../lib/types";
import { FileField } from "./FileField";

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

const field = "w-full rounded-sm border border-border bg-bg px-2 py-1";

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

/** SSH tunnel settings of a network connection (not shown for SQLite). */
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
    <fieldset className="flex flex-col gap-2 rounded-sm border border-border p-3">
      <legend className="px-1">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              onSecretChange("");
              onChange(e.target.checked ? NEW_SSH : null);
            }}
          />
          {strings.ssh.enable}
        </label>
      </legend>
      {ssh && (
        <>
          <div className="flex gap-3">
            <label className="flex flex-[3] flex-col gap-1">
              <span className="text-muted">{strings.ssh.host}</span>
              <input
                className={field}
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
            </label>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-muted">{strings.ssh.port}</span>
              <input
                type="number"
                className={field}
                placeholder={fromConfig ?? "22"}
                value={ssh.port ?? ""}
                onChange={(e) => patch({ port: e.target.value === "" ? null : Number(e.target.value) })}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-muted">{strings.ssh.user}</span>
            <input
              className={field}
              placeholder={fromConfig}
              value={ssh.user ?? ""}
              onChange={(e) => patch({ user: e.target.value || null })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted">{strings.ssh.auth}</span>
            <select
              className={field}
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
          </label>
          {isKey && (
            <FileField
              id="ssh-key-file"
              label={strings.ssh.keyFile}
              purpose="sshKey"
              value={ssh.keyFile}
              placeholder={strings.ssh.keyFilePlaceholder}
              onChange={(keyFile) => patch({ keyFile })}
            />
          )}
          {ssh.auth !== "agent" && (
            <div className="flex gap-3">
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-muted">{strings.ssh.secretMode}</span>
                <select
                  className={field}
                  value={ssh.secretMode}
                  onChange={(e) => patch({ secretMode: e.target.value as PasswordMode })}
                >
                  <option value="keyring">{strings.passwordMode.keyring}</option>
                  <option value="ask">{strings.passwordMode.ask}</option>
                  {isKey && <option value="none">{strings.ssh.noPassphrase}</option>}
                </select>
              </label>
              {ssh.secretMode === "keyring" && (
                <label className="flex flex-[2] flex-col gap-1">
                  <span className="text-muted">{isKey ? strings.ssh.passphrase : strings.ssh.password}</span>
                  <input
                    type="password"
                    className={field}
                    autoComplete="off"
                    value={secret}
                    placeholder={secretStored ? strings.form.passwordStored : ""}
                    onChange={(e) => onSecretChange(e.target.value)}
                  />
                </label>
              )}
            </div>
          )}
        </>
      )}
    </fieldset>
  );
}
