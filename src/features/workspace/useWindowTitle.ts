import { useEffect } from "react";
import * as ipc from "../../lib/ipc";
import type { EnvTag } from "../../lib/types";
import { windowTitle } from "../../lib/windowTitle";

/** Keeps the native window title in step with the shown workspace (null = connections screen). */
export function useWindowTitle(workspace: { name: string; envTag: EnvTag } | null) {
  const name = workspace?.name;
  const envTag = workspace?.envTag;
  useEffect(() => {
    const title = windowTitle(name === undefined || envTag === undefined ? null : { name, envTag });
    // A title that cannot be set (e.g. no native window in a browser preview) is cosmetic.
    void ipc.windowSetTitle(title)?.catch(() => {});
  }, [name, envTag]);
}
