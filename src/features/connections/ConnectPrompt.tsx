import { HostKeyPrompt } from "./HostKeyPrompt";
import { SecretPrompt } from "./SecretPrompt";
import type { useConnectFlow } from "./useConnectFlow";

interface Props {
  flow: Pick<ReturnType<typeof useConnectFlow>, "prompt" | "submit" | "trust" | "cancel">;
  connectionName: string;
}

/** The modal a connect flow currently asks for, if any. */
export function ConnectPrompt({ flow, connectionName }: Props) {
  const p = flow.prompt;
  if (!p) return null;
  return p.kind === "hostKey" ? (
    <HostKeyPrompt host={p.host} fingerprint={p.fingerprint} onTrust={flow.trust} onCancel={flow.cancel} />
  ) : (
    <SecretPrompt
      kind={p.kind}
      connectionName={connectionName}
      error={p.error}
      onSubmit={flow.submit}
      onCancel={flow.cancel}
    />
  );
}
