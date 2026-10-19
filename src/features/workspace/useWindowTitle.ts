import { useEffect } from "react";
import * as ipc from "../../lib/ipc";
import type { EnvTag } from "../../lib/types";
import { windowTitle } from "../../lib/windowTitle";
import { useConnections } from "../../stores/connections";

/**
 * Keeps the native window title in step with the shown workspace (null = connections
 * screen), with the live tag of its saved connection (the opened tag once it is deleted).
 */
export function useWindowTitle(workspace: { connectionId: string; name: string; envTag: EnvTag } | null) {
  const liveTag = useConnections((s) =>
    workspace ? s.items.find((c) => c.id === workspace.connectionId)?.envTag : undefined,
  );
  const name = workspace?.name;
  const envTag = liveTag ?? workspace?.envTag;
  useEffect(() => {
    const title = windowTitle(name === undefined || envTag === undefined ? null : { name, envTag });
    // A title that cannot be set (e.g. no native window in a browser preview) is cosmetic.
    void ipc.windowSetTitle(title)?.catch(() => {});
  }, [name, envTag]);
}
