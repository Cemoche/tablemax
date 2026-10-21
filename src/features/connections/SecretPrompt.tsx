import { useEffect, useState, type FormEvent } from "react";
import { strings } from "../../lib/strings";
import type { SecretPromptKind } from "./useConnectFlow";

interface Props {
  kind: SecretPromptKind;
  connectionName: string;
  error?: string | null;
  onSubmit: (secret: string) => void;
  onCancel: () => void;
}

/** Modal asking for the DB password, the SSH password or the SSH key passphrase. */
export function SecretPrompt({ kind, connectionName, error, onSubmit, onCancel }: Props) {
  const text = strings.secretPrompt[kind];
  const [secret, setSecret] = useState("");
  useEffect(() => {
    // Taken (preventDefault): the connection form behind does not close on the same press.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(secret);
  };
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-bg/70">
      <form
        role="dialog"
        aria-modal="true"
        aria-label={text.title}
        onSubmit={submit}
        className="w-80 rounded-md border border-border bg-surface p-4 shadow-lg"
      >
        <h2 className="mb-1 text-lg font-semibold">{text.title}</h2>
        <p className="mb-3 text-muted">{text.body(connectionName)}</p>
        <input
          autoFocus
          type="password"
          autoComplete="off"
          aria-label={text.label}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          className="w-full rounded-sm border border-border bg-bg px-2 py-1 outline-none focus-visible:focus-ring"
        />
        {error && <p className="mt-2 text-danger-text">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-sm border border-border px-3 py-1 outline-none focus-visible:focus-ring">
            {strings.secretPrompt.cancel}
          </button>
          <button type="submit" className="rounded-sm bg-accent-strong px-3 py-1 text-accent-contrast outline-none focus-visible:focus-ring">
            {strings.secretPrompt.ok}
          </button>
        </div>
      </form>
    </div>
  );
}
