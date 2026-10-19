import { useEffect, useRef } from "react";
import { strings } from "../../lib/strings";
import type { ConnectionConfig, Dialect } from "../../lib/types";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";

const p = strings.connectionPopover;

/** "PostgreSQL", "MariaDB"…: the saved connection's driver, else the workspace's dialect. */
export function engineLabel(cfg: ConnectionConfig | undefined, dialect: Dialect | null): string {
  const kind = cfg?.kind ?? dialect;
  return kind ? strings.driver[kind] : "";
}

const button =
  "rounded-md border border-pill-border bg-btn px-3 py-1 text-text outline-none hover:bg-seg-sel focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent disabled:text-icon-dim disabled:hover:bg-btn";

interface Props {
  workspace: Workspace;
  /** The saved connection (undefined once deleted: Edit is then unavailable). */
  cfg: ConnectionConfig | undefined;
  /** Where the popover hangs under its trigger. */
  align: "start" | "center";
  /** `refocus`: give the focus back to the trigger (Escape, a button), not after an outside click. */
  onClose: (refocus: boolean) => void;
  onEditConnection?: (cfg: ConnectionConfig) => void;
}

/**
 * What the workspace is connected to (engine, server, host, user, database, TLS) with
 * Edit, Reconnect and Disconnect. Not modal: shortcuts keep working; Escape or a click
 * outside closes it.
 */
export function ConnectionPopover({ workspace, cfg, align, onClose, onEditConnection }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current(true);
      }
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      // The trigger toggles the popover itself (the space around it closes the popover).
      const trigger = ref.current?.parentElement?.querySelector('[aria-haspopup="dialog"]');
      if (target && (ref.current?.contains(target) || trigger?.contains(target))) return;
      close.current(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, []);

  const sqlite = cfg?.kind === "sqlite" || (!cfg && workspace.dialect === "sqlite");
  const rows: [string, string][] = [
    [p.engine, engineLabel(cfg, workspace.dialect) || p.none],
    [p.server, workspace.serverVersion || p.none],
  ];
  if (sqlite) {
    rows.push([p.file, cfg?.sqlitePath || p.none]);
  } else {
    if (cfg) {
      const host = `${cfg.host}:${cfg.port}`;
      rows.push([p.host, cfg.ssh ? `${host} ${p.overSsh(cfg.ssh.host)}` : host]);
      rows.push([p.user, cfg.user || p.none]);
    }
    rows.push([p.database, workspace.database ?? cfg?.database ?? p.none]);
    if (cfg) rows.push([p.tls, strings.ssl.modes[cfg.ssl.mode]]);
  }

  const act = (fn: () => void) => () => {
    close.current(true);
    fn();
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={p.label}
      tabIndex={-1}
      className={`absolute top-full z-50 mt-1.5 w-80 rounded-lg border border-pill-border bg-content p-3 font-sans text-sm whitespace-normal text-text shadow-lg outline-none ${
        align === "center" ? "left-1/2 -translate-x-1/2" : "left-0"
      }`}
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-text-2">{label}</dt>
            <dd className="min-w-0 font-mono break-all">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          className={button}
          disabled={!cfg || !onEditConnection}
          onClick={act(() => cfg && onEditConnection?.(cfg))}
        >
          {p.edit}
        </button>
        <button
          type="button"
          className={button}
          disabled={workspace.status !== "disconnected"}
          onClick={act(() => useWorkspaces.getState().requestConnect(workspace.id))}
        >
          {p.reconnect}
        </button>
        <button
          type="button"
          className={button}
          onClick={act(() => void useWorkspaces.getState().closeWorkspace(workspace.id))}
        >
          {p.disconnect}
        </button>
      </div>
    </div>
  );
}
