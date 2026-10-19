import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { ConnectionConfig } from "../../lib/types";
import { useConnections } from "../../stores/connections";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { StatusPill, shortVersion } from "./StatusPill";

vi.mock("../../lib/ipc");

const s = strings.statusPill;
const p = strings.connectionPopover;

const cfg = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: "c1",
  name: "Demo",
  color: "swatch-2",
  envTag: "local",
  kind: "postgres",
  host: "127.0.0.1",
  port: 54321,
  user: "postgres",
  database: "tablemax_demo",
  sqlitePath: null,
  passwordMode: "keyring",
  group: null,
  ssl: { mode: "prefer", caFile: null, certFile: null, keyFile: null },
  ssh: null,
  ...over,
});

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: "w1",
  connectionId: "c1",
  name: "Demo",
  color: "swatch-2",
  envTag: "local",
  dialect: "postgres",
  status: "connected",
  serverVersion: "16.4 (Debian 16.4-1.pgdg120+2)",
  database: "tablemax_demo",
  schemas: ["public"],
  currentSchema: "public",
  tabs: [
    { id: "t1", kind: "table", object: { schema: "public", name: "orders" }, title: "orders", preview: false },
    { id: "q1", kind: "query", title: "Query 1", sql: "", sqlSessionId: null },
  ],
  activeTabId: "t1",
  mru: ["t1", "q1"],
  ...over,
});

const pill = () => screen.getByRole("button", { expanded: false });

beforeEach(() => {
  vi.resetAllMocks();
  useConnections.setState({ items: [cfg()] });
  useWorkspaces.setState({ workspaces: [ws()], activeWorkspaceId: "w1", connectRequest: null });
});

test("status_pill_text_and_color", () => {
  const { rerender } = render(<StatusPill workspace={ws()} />);
  expect(pill()).toHaveTextContent(/^PostgreSQL 16\.4 : tablemax_demo : public\.orders$/);
  expect(pill().className).toContain("bg-swatch-2");
  // Its own text color, readable on that swatch in both themes (tokens.test.ts).
  expect(pill().className).toContain("text-swatch-2-text");
  expect(pill().className).toContain("font-mono");

  // A SQL tab: the schema only.
  rerender(<StatusPill workspace={ws({ activeTabId: "q1" })} />);
  expect(pill()).toHaveTextContent(/^PostgreSQL 16\.4 : tablemax_demo : public$/);

  // The live color of the saved connection.
  useConnections.setState({ items: [cfg({ color: "swatch-5" })] });
  rerender(<StatusPill workspace={ws()} />);
  expect(pill().className).toContain("bg-swatch-5");

  // MariaDB names itself; SQLite shows its file.
  useConnections.setState({ items: [cfg({ kind: "mariaDb" })] });
  rerender(<StatusPill workspace={ws({ dialect: "mySql", serverVersion: "10.11.6-MariaDB-1:10.11.6+maria~ubu2204", database: null, currentSchema: "shop", activeTabId: "q1" })} />);
  expect(pill()).toHaveTextContent(/^MariaDB 10\.11\.6 : shop$/);
  useConnections.setState({
    items: [cfg({ kind: "sqlite", database: null, sqlitePath: "/home/u/data/demo.db" })],
  });
  rerender(<StatusPill workspace={ws({ dialect: "sqlite", serverVersion: "3.46.0", database: null, currentSchema: "main", activeTabId: "q1" })} />);
  expect(pill()).toHaveTextContent(/^SQLite 3\.46\.0 : demo\.db : main$/);
});

test("shortVersion keeps the version number", () => {
  expect(shortVersion("16.4 (Debian 16.4-1.pgdg120+2)")).toBe("16.4");
  expect(shortVersion("8.0.36")).toBe("8.0.36");
  expect(shortVersion("11.4.2-MariaDB-ubu2404")).toBe("11.4.2");
  expect(shortVersion("")).toBe("");
  expect(shortVersion(null)).toBe("");
});

test("connecting, reconnecting and error use the state tokens", () => {
  const { rerender } = render(<StatusPill workspace={ws({ status: "connecting", serverVersion: undefined })} />);
  expect(pill()).toHaveTextContent(s.connecting("Demo"));
  expect(pill().className).not.toContain("bg-swatch");
  expect(pill().className).toContain("text-status-connecting");

  // Connected before in this session: reconnecting.
  rerender(<StatusPill workspace={ws({ status: "connecting" })} />);
  expect(pill()).toHaveTextContent(s.reconnecting("Demo"));

  rerender(<StatusPill workspace={ws({ status: "disconnected" })} connectError="password authentication failed" />);
  expect(pill()).toHaveTextContent(s.error("Demo"));
  expect(pill().className).toContain("text-status-error");
  expect(pill()).toHaveAttribute("title", expect.stringContaining("password authentication failed"));

  rerender(<StatusPill workspace={ws({ status: "disconnected" })} />);
  expect(pill()).toHaveTextContent(s.disconnected("Demo"));
});

test("status_pill_keeps_prod_badge_when_truncated", () => {
  const long = `analytics_${"x".repeat(300)}`;
  useConnections.setState({ items: [cfg({ envTag: "prod", database: long })] });
  const { rerender } = render(<StatusPill workspace={ws({ envTag: "prod", database: long })} />);
  const button = pill();
  const badge = within(button).getByText(s.prod);
  const text = within(button).getByText(new RegExp(`^PostgreSQL 16\\.4 : ${long}`));
  // One line: the text shrinks with an ellipsis, the badge never does and is not inside it.
  expect(button.className).toContain("whitespace-nowrap");
  expect(button.className).toContain("overflow-hidden");
  expect(text.className).toContain("truncate");
  expect(text.className).toContain("min-w-0");
  expect(badge.className).toContain("shrink-0");
  expect(text.contains(badge)).toBe(false);
  // The full text stays readable as a tooltip.
  expect(button).toHaveAttribute("title", expect.stringContaining(long));

  // Also while connecting or failed.
  rerender(<StatusPill workspace={ws({ envTag: "prod", status: "connecting" })} />);
  expect(within(pill()).getByText(s.prod)).toBeInTheDocument();
  rerender(<StatusPill workspace={ws({ envTag: "prod", status: "disconnected" })} connectError="boom" />);
  expect(within(pill()).getByText(s.prod)).toBeInTheDocument();
});

test("the PROD badge follows the live tag of the saved connection", () => {
  const { rerender } = render(<StatusPill workspace={ws()} />);
  expect(within(pill()).queryByText(s.prod)).toBeNull();
  // Retagged prod while open: at once.
  useConnections.setState({ items: [cfg({ envTag: "prod" })] });
  rerender(<StatusPill workspace={ws()} />);
  expect(within(pill()).getByText(s.prod)).toBeInTheDocument();
  // A deleted connection keeps the tag it was opened with.
  useConnections.setState({ items: [] });
  rerender(<StatusPill workspace={ws({ envTag: "prod" })} />);
  expect(within(pill()).getByText(s.prod)).toBeInTheDocument();
});

test("a click opens the connection popover: details, Edit, Reconnect, Disconnect", async () => {
  const user = userEvent.setup();
  const onEdit = vi.fn();
  const closeWorkspace = vi.fn();
  useWorkspaces.setState({ closeWorkspace });
  render(<StatusPill workspace={ws()} onEditConnection={onEdit} />);
  await user.click(pill());
  const dialog = screen.getByRole("dialog", { name: p.label });
  expect(dialog).not.toHaveAttribute("aria-modal", "true");
  const value = (label: string) => within(dialog).getByText(label).nextElementSibling?.textContent;
  expect(value(p.engine)).toBe("PostgreSQL");
  expect(value(p.server)).toBe("16.4 (Debian 16.4-1.pgdg120+2)");
  expect(value(p.host)).toBe("127.0.0.1:54321");
  expect(value(p.user)).toBe("postgres");
  expect(value(p.database)).toBe("tablemax_demo");
  expect(value(p.tls)).toBe(strings.ssl.modes.prefer);
  // Connected: nothing to reconnect.
  expect(within(dialog).getByRole("button", { name: p.reconnect })).toBeDisabled();

  await user.click(within(dialog).getByRole("button", { name: p.edit }));
  expect(onEdit).toHaveBeenCalledWith(cfg());
  expect(screen.queryByRole("dialog")).toBeNull();

  await user.click(pill());
  await user.click(screen.getByRole("button", { name: p.disconnect }));
  expect(closeWorkspace).toHaveBeenCalledWith("w1");
});

test("Escape closes the popover and gives the focus back to the pill", async () => {
  const user = userEvent.setup();
  render(<StatusPill workspace={ws()} />);
  await user.click(pill());
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(pill()).toHaveFocus();
});

test("a disconnected workspace can be reconnected from the popover", async () => {
  const user = userEvent.setup();
  const w = ws({ status: "disconnected" });
  useWorkspaces.setState({ workspaces: [w] });
  render(<StatusPill workspace={w} />);
  await user.click(pill());
  await user.click(screen.getByRole("button", { name: p.reconnect }));
  expect(useWorkspaces.getState().connectRequest).toEqual({ workspaceId: "w1" });
  expect(ipc.workspaceOpen).not.toHaveBeenCalled();
});

test("SQLite shows its file and no TLS", async () => {
  const user = userEvent.setup();
  useConnections.setState({ items: [cfg({ kind: "sqlite", sqlitePath: "/data/demo.db", database: null })] });
  render(<StatusPill workspace={ws({ dialect: "sqlite", database: null, serverVersion: "3.46.0" })} />);
  await user.click(pill());
  const dialog = screen.getByRole("dialog");
  const value = (label: string) => within(dialog).getByText(label).nextElementSibling?.textContent;
  expect(value(p.file)).toBe("/data/demo.db");
  expect(within(dialog).queryByText(p.host)).toBeNull();
  expect(within(dialog).queryByText(p.tls)).toBeNull();
});

test("a press beside the pill closes the popover", async () => {
  const user = userEvent.setup();
  render(<StatusPill workspace={ws()} />);
  const trigger = pill();
  await user.click(trigger);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await user.click(trigger.parentElement as HTMLElement);
  expect(screen.queryByRole("dialog")).toBeNull();
});
