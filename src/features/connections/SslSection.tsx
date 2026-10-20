import { sslModesFor, tlsRisk } from "../../lib/ssl";
import { strings } from "../../lib/strings";
import { tip } from "../../lib/tooltip";
import type { DriverKind, FilePurpose, SslConfig, SslMode } from "../../lib/types";
import { FileField, useFilePick } from "./FileField";
import { buttonClass, fieldClass, labelClass, rowClass } from "./formStyles";

interface Props {
  kind: DriverKind;
  /** The DB host, for the cleartext / unverified warning. */
  host: string;
  overSsh: boolean;
  ssl: SslConfig;
  onChange: (ssl: SslConfig) => void;
}

type FileKey = "caFile" | "certFile" | "keyFile";

const FILES: { key: FileKey; purpose: FilePurpose; label: string; short: string; placeholder?: string }[] = [
  { key: "caFile", purpose: "caCert", label: strings.ssl.caFile, short: strings.ssl.caShort, placeholder: strings.ssl.caPlaceholder },
  { key: "certFile", purpose: "clientCert", label: strings.ssl.certFile, short: strings.ssl.certShort },
  { key: "keyFile", purpose: "clientKey", label: strings.ssl.keyFile, short: strings.ssl.keyShort },
];

/** CA… / Cert… / Key… on the SSL mode line: each opens the native picker for its file. */
function BrowseButton({ file, ssl, onChange }: { file: (typeof FILES)[number]; ssl: SslConfig; onChange: (ssl: SslConfig) => void }) {
  const { browse, error } = useFilePick(file.purpose, (path) => onChange({ ...ssl, [file.key]: path }));
  return (
    <button
      type="button"
      className={`${buttonClass} px-2 ${ssl[file.key] !== null ? "font-medium" : ""} ${error ? "text-danger" : ""}`}
      aria-label={strings.ssl.browseFor(file.label)}
      {...tip(error ?? ssl[file.key] ?? file.label)}
      onClick={browse}
    >
      {file.short}
    </button>
  );
}

/**
 * TLS of a network connection (not shown for SQLite), compact (spec §2.4): the mode with
 * CA… / Cert… / Key… on one line; a chosen file gets a line of its own with its path and
 * Clear; the cleartext / unverified warning under them.
 */
export function SslSection({ kind, host, overSsh, ssl, onChange }: Props) {
  const risk = tlsRisk(host, overSsh, ssl.mode);
  return (
    <>
      <div data-form-row="" className={rowClass}>
        <label htmlFor="cf-ssl-mode" className={labelClass}>
          {strings.ssl.mode}
        </label>
        <div className="flex min-w-0 items-center gap-2">
          <select
            id="cf-ssl-mode"
            className={fieldClass}
            value={ssl.mode}
            onChange={(e) => onChange({ ...ssl, mode: e.target.value as SslMode })}
          >
            {sslModesFor(kind).map((m) => (
              <option key={m} value={m}>
                {strings.ssl.modes[m]}
              </option>
            ))}
          </select>
          {FILES.map((f) => (
            <BrowseButton key={f.key} file={f} ssl={ssl} onChange={onChange} />
          ))}
        </div>
      </div>
      {FILES.filter((f) => ssl[f.key] !== null).map((f) => (
        <FileField
          key={f.key}
          id={`ssl-${f.key}`}
          label={f.label}
          purpose={f.purpose}
          value={ssl[f.key]}
          placeholder={f.placeholder}
          noBrowse
          rowClass={rowClass}
          onChange={(path) => onChange({ ...ssl, [f.key]: path })}
        />
      ))}
      {risk && (
        <div data-form-row="" className="grid min-h-7 grid-cols-[104px_minmax(0,1fr)] gap-x-3">
          <span />
          <p role="note" className="text-sm text-warning">
            {risk === "cleartext" ? strings.ssl.cleartextWarning : strings.ssl.unverifiedWarning}
          </p>
        </div>
      )}
    </>
  );
}
