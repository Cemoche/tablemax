import { useRef, useState } from "react";
import { strings } from "../../lib/strings";
import { tip, tipIfCut } from "../../lib/tooltip";
import type { ConnectionConfig } from "../../lib/types";
import { useConnections } from "../../stores/connections";
import type { Workspace } from "../../stores/workspaces";
import { ConnectionPopover, engineLabel } from "./ConnectionPopover";
import { tagClass, tintClass } from "./swatch";

const s = strings.statusPill;

type PillState = "connected" | "connecting" | "reconnecting" | "error" | "disconnected";

/** Pill colors per state: the connection color once connected, state tokens otherwise. */
const STATE_CLASS: Record<Exclude<PillState, "connected">, { pill: string; dot: string }> = {
  connecting: { pill: "border border-pill-border bg-pill text-status-connecting", dot: "bg-status-connecting animate-pulse" },
  reconnecting: { pill: "border border-pill-border bg-pill text-status-connecting", dot: "bg-status-connecting animate-pulse" },
  error: { pill: "border border-pill-border bg-pill text-status-error", dot: "bg-status-error" },
  disconnected: { pill: "border border-pill-border bg-pill text-text-2", dot: "bg-icon-dim" },
};

/** The version number of a server version string: "16.4 (Debian …)" → "16.4", "11.4.2-MariaDB-…" → "11.4.2". */
export function shortVersion(version: string | null | undefined): string {
  return (version ?? "").trim().split(/\s/)[0].split("-")[0];
}

/**
 * `<Engine> <version> : SSH : <connection name> : <database> : <schema>.<object>`, without
 * the parts that are unknown (SSH only through a tunnel; the name once if it is the database).
 */
export function statusText(workspace: Workspace, cfg: ConnectionConfig | undefined): string {
  const engine = [engineLabel(cfg, workspace.dialect), shortVersion(workspace.serverVersion)]
    .filter(Boolean)
    .join(" ");
  const sqliteFile = cfg?.kind === "sqlite" ? (cfg.sqlitePath?.split("/").pop() ?? null) : null;
  const database = workspace.database ?? sqliteFile;
  const tab = workspace.tabs.find((t) => t.id === workspace.activeTabId);
  const where =
    tab?.kind === "table"
      ? [tab.object.schema, tab.object.name].filter(Boolean).join(".")
      : (workspace.currentSchema ?? "");
  // MySQL: the database is the schema, said once.
  const schema = tab?.kind === "table" ? tab.object.schema : workspace.currentSchema;
  const name = cfg?.name ?? workspace.name;
  const shownDatabase = database === schema ? null : database;
  const parts = [engine, cfg?.ssh ? s.ssh : null, name === shownDatabase ? null : name, shownDatabase, where];
  return parts.filter((x): x is string => !!x).join(s.separator);
}

function pillState(workspace: Workspace, connectError: string | null): PillState {
  switch (workspace.status) {
    case "connected":
      return "connected";
    case "connecting":
      // Connected before in this session: the server version is known.
      return workspace.serverVersion ? "reconnecting" : "connecting";
    default:
      return connectError ? "error" : "disconnected";
  }
}

interface Props {
  workspace: Workspace;
  /** Why the last connect of this (disconnected) workspace failed. */
  connectError?: string | null;
  onEditConnection?: (cfg: ConnectionConfig) => void;
}

/**
 * The center of the toolbar (#104): the connection's tag (`LOCAL`, `DEV`, `STAGING`, `PROD`)
 * then where the workspace is (`PostgreSQL 16.4 : SSH : Shop : shop : public.orders`) in
 * monospace on a tint of the connection's color, or its connection state. The tag never
 * shrinks (the text is cut with an ellipsis first). The right end keeps an empty slot for
 * the network throughput, which needs a byte counter from the backend (not built yet: no
 * number is shown, never a fake one). A click opens the connection popover.
 */
export function StatusPill({ workspace, connectError = null, onEditConnection }: Props) {
  const cfg = useConnections((st) => st.items.find((c) => c.id === workspace.connectionId));
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const envTag = cfg?.envTag ?? workspace.envTag;
  const color = cfg?.color ?? workspace.color;
  const state = pillState(workspace, connectError);
  const text =
    state === "connected"
      ? statusText(workspace, cfg)
      : state === "connecting"
        ? s.connecting(workspace.name)
        : state === "reconnecting"
          ? s.reconnecting(workspace.name)
          : state === "error"
            ? s.error(workspace.name)
            : s.disconnected(workspace.name);
  const tagLabel = s.tags[envTag] ?? s.tags.local;
  const look = state === "connected" ? tintClass(color) : STATE_CLASS[state].pill;

  return (
    // The pill takes the free space; the wrapper's padding on its sides stays a drag area of
    // the title bar (AppToolbar handles presses there).
    <div data-pill-area="" className="relative flex min-w-0 flex-1 basis-48 justify-center px-4">
      <button
        ref={trigger}
        type="button"
        // "LOCAL | PostgreSQL …": the badge and the text read apart (an explicit name, since
        // name computation trims the spaces a visually hidden separator would carry).
        aria-label={`${tagLabel}${s.tagSeparator}${text}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        {...(state === "error" && connectError ? tip(s.errorTitle(text, connectError)) : tipIfCut(text))}
        onClick={() => setOpen((o) => !o)}
        className={`relative flex h-8.5 w-full min-w-0 items-center justify-center gap-2 overflow-hidden rounded-full px-4 font-mono text-sm font-medium whitespace-nowrap outline-none focus-visible:focus-ring ${look}`}
      >
        <span
          data-pill-tag=""
          className={`shrink-0 rounded-sm border border-current px-1.5 font-sans text-xs font-bold tracking-wide ${tagClass(envTag)}`}
        >
          {tagLabel}
        </span>
        {state !== "connected" && <span aria-hidden className={`size-2 shrink-0 rounded-full ${STATE_CLASS[state].dot}`} />}
        <span data-pill-text="" className="min-w-0 truncate">
          {text}
        </span>
        {/* Network throughput: empty until the backend counts bytes (follow-up issue). */}
        <span data-throughput-slot="" aria-hidden className="absolute right-4 font-sans text-xs" />
      </button>
      {open && (
        <ConnectionPopover
          workspace={workspace}
          cfg={cfg}
          align="center"
          onEditConnection={onEditConnection}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) trigger.current?.focus();
          }}
        />
      )}
    </div>
  );
}
