import { enforcedSafeMode } from "../../lib/safeMode";
import type { EnvTag, SafeMode } from "../../lib/types";
import { useConnections } from "../../stores/connections";
import type { Workspace } from "../../stores/workspaces";

export type LiveEnvSource = Pick<Workspace, "connectionId" | "envTag" | "safeMode">;

/**
 * What a workspace shows about its environment: the live tag of the saved connection (what
 * the connection list shows; the opened tag once it is deleted) and the safe mode the
 * backend actually enforces (the stricter of saved and opened, Ruling R16).
 */
export function useLiveEnv(workspace: LiveEnvSource): { envTag: EnvTag; mode: SafeMode } {
  const saved = useConnections((s) => s.items.find((c) => c.id === workspace.connectionId));
  const opened = { envTag: workspace.envTag, safeMode: workspace.safeMode };
  return { envTag: saved?.envTag ?? workspace.envTag, mode: enforcedSafeMode(saved, opened) };
}
