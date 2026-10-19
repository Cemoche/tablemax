import { useRef, useState } from "react";
import { strings } from "../../lib/strings";
import type { ConnectionConfig } from "../../lib/types";
import { useConnections } from "../../stores/connections";
import type { Workspace } from "../../stores/workspaces";
import { ConnectionPopover, engineLabel } from "./ConnectionPopover";

const s = strings.statusPill;

/**
 * The connection color and its text color (≥ 4.5:1, tokens.test.ts). Tailwind needs the
 * literal class names. Unknown ids fall back to the gray swatch.
 */
const SWATCH: Record<string, string> = {
  "swatch-1": "bg-swatch-1 text-swatch-1-text",
  "swatch-2": "bg-swatch-2 text-swatch-2-text",
  "swatch-3": "bg-swatch-3 text-swatch-3-text",
  "swatch-4": "bg-swatch-4 text-swatch-4-text",
  "swatch-5": "bg-swatch-5 text-swatch-5-text",
  "swatch-6": "bg-swatch-6 text-swatch-6-text",
};

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

/** `<Engine> <version> : <database> : <schema>.<object>`, without the parts that are unknown. */
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
  const parts = [engine, database === schema ? null : database, where];
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
 * The center of the toolbar: where the workspace is (`PostgreSQL 16.4 : shop : public.orders`)
 * in monospace on the connection's color, or its connection state; a `PROD` badge for a
 * production connection that never shrinks (the text is cut with an ellipsis first). A
 * click opens the connection popover.
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
  const look =
    state === "connected" ? (SWATCH[color] ?? SWATCH["swatch-4"]) : STATE_CLASS[state].pill;

  return (
    // The wrapper takes the free space; the pill is capped and centred so the space on its
    // sides stays a drag area of the title bar (AppToolbar handles presses there).
    <div data-pill-area="" className="relative flex min-w-0 flex-1 basis-48 justify-center">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={state === "error" && connectError ? s.errorTitle(text, connectError) : text}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-8.5 w-full max-w-140 min-w-0 items-center justify-center gap-2 overflow-hidden rounded-full px-4 font-mono text-sm font-medium whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent ${look}`}
      >
        {state !== "connected" && <span aria-hidden className={`size-2 shrink-0 rounded-full ${STATE_CLASS[state].dot}`} />}
        <span className="min-w-0 truncate">{text}</span>
        {envTag === "prod" && (
          <span className="shrink-0 rounded-sm border border-current bg-tag-prod-bg px-1.5 font-sans text-xs font-bold text-tag-prod-text">
            {s.prod}
          </span>
        )}
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
