import { isCleartextRisk, sslModesFor } from "../../lib/ssl";
import { strings } from "../../lib/strings";
import type { DriverKind, SslConfig, SslMode } from "../../lib/types";
import { FileField } from "./FileField";

interface Props {
  kind: DriverKind;
  /** The DB host, for the cleartext warning. */
  host: string;
  overSsh: boolean;
  ssl: SslConfig;
  onChange: (ssl: SslConfig) => void;
}

const FILES = [
  { key: "caFile", purpose: "caCert", label: strings.ssl.caFile, placeholder: strings.ssl.caPlaceholder },
  { key: "certFile", purpose: "clientCert", label: strings.ssl.certFile },
  { key: "keyFile", purpose: "clientKey", label: strings.ssl.keyFile },
] as const;

/** TLS mode and files of a network connection (not shown for SQLite). */
export function SslSection({ kind, host, overSsh, ssl, onChange }: Props) {
  return (
    <fieldset className="flex flex-col gap-2 rounded-sm border border-border p-3">
      <legend className="px-1 text-muted">{strings.ssl.legend}</legend>
      <label className="flex flex-col gap-1">
        <span className="text-muted">{strings.ssl.mode}</span>
        <select
          className="w-full rounded-sm border border-border bg-bg px-2 py-1"
          value={ssl.mode}
          onChange={(e) => onChange({ ...ssl, mode: e.target.value as SslMode })}
        >
          {sslModesFor(kind).map((m) => (
            <option key={m} value={m}>
              {strings.ssl.modes[m]}
            </option>
          ))}
        </select>
      </label>
      {isCleartextRisk(host, overSsh, ssl.mode) && (
        <p role="note" className="text-warning">
          {strings.ssl.cleartextWarning}
        </p>
      )}
      {FILES.map((f) => (
        <FileField
          key={f.key}
          id={`ssl-${f.key}`}
          label={f.label}
          purpose={f.purpose}
          value={ssl[f.key]}
          placeholder={"placeholder" in f ? f.placeholder : undefined}
          onChange={(path) => onChange({ ...ssl, [f.key]: path })}
        />
      ))}
    </fieldset>
  );
}
