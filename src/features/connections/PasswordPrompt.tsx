import { useState, type FormEvent } from "react";
import { strings } from "../../lib/strings";

interface Props {
  connectionName: string;
  error?: string | null;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

export function PasswordPrompt({ connectionName, error, onSubmit, onCancel }: Props) {
  const [password, setPassword] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(password);
  };
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-bg/70">
      <form
        role="dialog"
        aria-modal="true"
        aria-label={strings.prompt.title}
        onSubmit={submit}
        className="w-80 rounded-md border border-border bg-surface p-4 shadow-lg"
      >
        <h2 className="mb-1 text-lg font-semibold">{strings.prompt.title}</h2>
        <p className="mb-3 text-muted">{strings.prompt.body(connectionName)}</p>
        <input
          autoFocus
          type="password"
          aria-label={strings.form.password}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-sm border border-border bg-bg px-2 py-1"
        />
        {error && <p className="mt-2 text-danger">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-sm border border-border px-3 py-1">
            {strings.prompt.cancel}
          </button>
          <button type="submit" className="rounded-sm bg-accent px-3 py-1 text-accent-contrast">
            {strings.prompt.ok}
          </button>
        </div>
      </form>
    </div>
  );
}
