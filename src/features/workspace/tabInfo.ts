import { strings } from "../../lib/strings";
import type { Tab, Workspace } from "../../stores/workspaces";

export const tabKindLabel = (t: Tab) => strings.workspace.tabKind[t.kind];
export const tabSchema = (t: Tab) => (t.kind === "table" ? (t.object.schema ?? "") : "");

/** Tabs in most-recently-used order; tabs missing from `mru` go last, in bar order. */
export function tabsByMru(w: Workspace): Tab[] {
  const byId = new Map(w.tabs.map((t) => [t.id, t]));
  const ordered = w.mru.flatMap((id) => byId.get(id) ?? []);
  const seen = new Set(ordered.map((t) => t.id));
  return [...ordered, ...w.tabs.filter((t) => !seen.has(t.id))];
}
