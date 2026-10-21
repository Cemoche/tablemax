import { useState } from "react";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import { tip } from "../../lib/tooltip";
import type { FilePurpose } from "../../lib/types";
import { buttonClass, fieldClass, labelClass } from "./formStyles";

/** The native file picker (opened by the backend): the chosen path, or the error to show. */
export function useFilePick(purpose: FilePurpose, onChange: (path: string) => void) {
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
  return { browse, error };
}

interface Props {
  id: string;
  /** Visible label, in the label column. */
  label: string;
  /** Accessible name of the path, when the visible label is a short form of it. */
  name?: string;
  purpose: FilePurpose;
  value: string | null;
  placeholder?: string;
  onChange: (path: string | null) => void;
  /** Leave out Browse… (the SSL files are browsed from the SSL mode line). */
  noBrowse?: boolean;
  /** Class of the line (the form's row, or the Over SSH box's). */
  rowClass: string;
}

/** A form line with a read-only path chosen with the native picker, Browse… and Clear. */
export function FileField({ id, label, name, purpose, value, placeholder, onChange, noBrowse, rowClass }: Props) {
  const { browse, error } = useFilePick(purpose, onChange);
  const what = name ?? label;
  return (
    <div data-form-row="" className={rowClass}>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-2">
        <input
          id={id}
          readOnly
          aria-label={name}
          className={`${fieldClass} font-mono`}
          value={value ?? ""}
          placeholder={placeholder ?? strings.ssl.noFile}
        />
        {error && (
          <span role="alert" className="max-w-40 shrink-0 truncate text-xs text-danger-text" {...tip(error)}>
            {error}
          </span>
        )}
        {!noBrowse && (
          <button type="button" className={buttonClass} aria-label={strings.ssl.browseFor(what)} onClick={browse}>
            {strings.ssl.browse}
          </button>
        )}
        {value !== null && (
          <button type="button" className={buttonClass} aria-label={strings.ssl.clearFor(what)} onClick={() => onChange(null)}>
            {strings.ssl.clear}
          </button>
        )}
      </div>
    </div>
  );
}
