import { useEffect } from "react";
import { strings } from "../../lib/strings";

interface Props {
  /** The SSH server whose key is checked ("host:port" after ~/.ssh/config). */
  host: string;
  /** "SHA256:…", as `ssh-keygen -lf` prints it. */
  fingerprint: string;
  onTrust: () => void;
  onCancel: () => void;
}

/** Modal asking to trust the key of an SSH server known_hosts has no key for. */
export function HostKeyPrompt({ host, fingerprint, onTrust, onCancel }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-bg/70">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={strings.ssh.unknownHostTitle}
        className="w-[28rem] rounded-md border border-border bg-surface p-4 shadow-lg"
      >
        <h2 className="mb-1 text-lg font-semibold">{strings.ssh.unknownHostTitle}</h2>
        <p className="mb-2 font-semibold break-all">{host}</p>
        <p className="mb-3 text-muted">{strings.ssh.unknownHostExplain}</p>
        <p className="text-xs text-muted">{strings.ssh.fingerprint}</p>
        <p className="mb-3 rounded-sm border border-border bg-bg px-2 py-1 font-mono break-all select-all">
          {fingerprint}
        </p>
        <div className="flex justify-end gap-2">
          {/* Cancel first and focused: Enter never trusts a key by accident. */}
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="rounded-sm border border-border px-3 py-1"
          >
            {strings.ssh.cancel}
          </button>
          <button
            type="button"
            onClick={onTrust}
            className="rounded-sm bg-accent-strong px-3 py-1 text-accent-contrast"
          >
            {strings.ssh.trust}
          </button>
        </div>
      </div>
    </div>
  );
}
