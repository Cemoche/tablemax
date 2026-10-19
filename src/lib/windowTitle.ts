import { strings } from "./strings";
import type { EnvTag } from "./types";

/** `TableMax`, or `TableMax — <name>` with ` [PROD]` / ` [STAGING]` for those tags. */
export function windowTitle(workspace: { name: string; envTag: EnvTag } | null): string {
  if (!workspace) return strings.appName;
  const tag = workspace.envTag === "prod" || workspace.envTag === "staging" ? workspace.envTag.toUpperCase() : null;
  return `${strings.appName}${strings.windowTitle.separator}${workspace.name}${tag ? ` [${tag}]` : ""}`;
}
