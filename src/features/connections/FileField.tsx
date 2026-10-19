import { useState } from "react";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { FilePurpose } from "../../lib/types";

interface Props {
  id: string;
  label: string;
  purpose: FilePurpose;
  value: string | null;
  placeholder?: string;
  onChange: (path: string | null) => void;
}

const btn = "rounded-sm border border-border px-2 py-1 hover:bg-surface-2";

/** Read-only path chosen with the native picker (opened by the backend), with Clear. */
export function FileField({ id, label, purpose, value, placeholder, onChange }: Props) {
  const [error, setError] = useState<string | null>(null);
  const browse = async () => {
    setError(null);
    try {
      const path = await ipc.filePick(purpose);
      if (path !== null) onChange(path);
    } catch (e) {
      setError(toAppError(e).message);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-muted">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          readOnly
          className="min-w-0 flex-1 rounded-sm border border-border bg-bg px-2 py-1 font-mono"
          value={value ?? ""}
          placeholder={placeholder ?? strings.ssl.noFile}
        />
        <button type="button" className={btn} aria-label={strings.ssl.browseFor(label)} onClick={browse}>
          {strings.ssl.browse}
        </button>
        {value !== null && (
          <button
            type="button"
            className={btn}
            aria-label={strings.ssl.clearFor(label)}
            onClick={() => onChange(null)}
          >
            {strings.ssl.clear}
          </button>
        )}
      </div>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
