import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { Catalog, ConnectionConfig } from "../../lib/types";
import { useCatalog } from "../../stores/catalog";
import { useConnections } from "../../stores/connections";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { registerEditorCommands } from "../editor/editorCommands";
import { CommandPalette } from "./CommandPalette";

vi.mock("../../lib/ipc");

const workspace = (over: Partial<Workspace> = {}): Workspace => ({
  id: "w1",
  connectionId: "c1",
  name: "PG",
  color: "swatch-1",
  envTag: "local",
  dialect: "postgres",
  status: "connected",
  database: "app",
  schemas: ["public", "audit"],
  currentSchema: "public",
  tabs: [{ id: "q1", kind: "query", title: "Query 1", sql: "", sqlSessionId: null }],
  activeTabId: "q1",
  mru: ["q1"],
  ...over,
});

const catalog = (names: string[]): Catalog => ({
  schema: "public",
  tables: names.map((name) => ({ name, kind: "table", columns: [] })),
});

const conn = { id: "c1", name: "Prod PG", envTag: "prod" } as ConnectionConfig;

const firstName = () => screen.getAllByRole("option")[0].firstElementChild?.textContent;

const open = async (chord: string) => {
  const user = userEvent.setup();
  render(<CommandPalette onOpenConnection={vi.fn()} onNewConnection={vi.fn()} onShowWorkspace={vi.fn()} />);
  await user.keyboard(chord);
  return user;
};
const MOD_K = "{Control>}k{/Control}";
const MOD_P = "{Control>}p{/Control}";

beforeEach(() => {
  vi.resetAllMocks();
  useCatalog.setState({ catalogs: {}, errors: {}, loading: {} });
  useConnections.setState({ items: [conn] });
  useWorkspaces.setState({ workspaces: [workspace()], activeWorkspaceId: "w1", sidebarVisible: true });
  vi.mocked(ipc.catalogGet).mockResolvedValue(catalog(["users", "orders", "order_items"]));
});

test("Mod+K shows objects, tabs, connections and actions in a modal dialog", async () => {
  await open(MOD_K);
  const dialog = await screen.findByRole("dialog", { name: strings.palette.label });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(screen.getByRole("combobox")).toHaveFocus();
  await screen.findByText("users");
  for (const heading of [
    strings.palette.objects,
    strings.palette.tabs,
    strings.palette.connections,
    strings.palette.actions,
  ]) {
    expect(within(dialog).getByText(heading)).toBeInTheDocument();
  }
  expect(within(dialog).getByText("Query 1")).toBeInTheDocument();
  expect(within(dialog).getByText("Prod PG")).toBeInTheDocument();
  expect(within(dialog).getByText(strings.palette.action.newQuery)).toBeInTheDocument();
  expect(within(dialog).getByText("Ctrl+T")).toBeInTheDocument();
});

test("Mod+P shows only the objects", async () => {
  await open(MOD_P);
  const dialog = await screen.findByRole("dialog");
  await screen.findByText("users");
  expect(within(dialog).queryByText(strings.palette.tabs)).not.toBeInTheDocument();
  expect(within(dialog).queryByText(strings.palette.connections)).not.toBeInTheDocument();
  expect(within(dialog).queryByText(strings.palette.actions)).not.toBeInTheDocument();
  expect(within(dialog).queryByText(strings.palette.action.newQuery)).not.toBeInTheDocument();
});

test("Escape closes and Mod+K toggles", async () => {
  const user = await open(MOD_K);
  await screen.findByRole("dialog");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.keyboard(MOD_K);
  await screen.findByRole("dialog");
  await user.keyboard(MOD_K);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("it does not open over another modal dialog", async () => {
  render(
    <>
      <div role="dialog" aria-modal="true" />
      <CommandPalette onOpenConnection={vi.fn()} onNewConnection={vi.fn()} onShowWorkspace={vi.fn()} />
    </>,
  );
  await userEvent.setup().keyboard(MOD_K);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});

test("selecting an object opens a preview tab", async () => {
  const onShow = vi.fn();
  const user = userEvent.setup();
  render(<CommandPalette onOpenConnection={vi.fn()} onNewConnection={vi.fn()} onShowWorkspace={onShow} />);
  await user.keyboard(MOD_P);
  await user.type(await screen.findByRole("combobox"), "order_i");
  await user.click(await screen.findByText("order_items"));
  const w = useWorkspaces.getState().workspaces[0];
  const tab = w.tabs.find((t) => t.kind === "table");
  expect(tab).toMatchObject({ preview: true, object: { schema: "public", name: "order_items" } });
  expect(w.activeTabId).toBe(tab?.id);
  expect(onShow).toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("palette_caps_results: 5 000 tables render at most 200 items and the best match comes first", async () => {
  const names = Array.from({ length: 5000 }, (_, i) => `tbl_${String(i).padStart(4, "0")}`);
  names.push("tbl_4", "tbl_42");
  vi.mocked(ipc.catalogGet).mockResolvedValue(catalog(names));
  const user = await open(MOD_P);
  const input = await screen.findByRole("combobox");
  await screen.findAllByRole("option");
  expect(screen.getAllByRole("option").length).toBeLessThanOrEqual(200);
  await user.type(input, "tbl_4");
  await waitFor(() => expect(firstName()).toBe("tbl_4"));
  expect(screen.getAllByRole("option").length).toBeLessThanOrEqual(200);
  expect(screen.getByText(/^Showing the first 200 of \d+\./)).toBeInTheDocument();
  await user.type(input, "2");
  await waitFor(() => expect(firstName()).toBe("tbl_42"));
  // Loaded once for the schema, however often the palette re-renders.
  expect(ipc.catalogGet).toHaveBeenCalledTimes(1);
});

test("a disconnected workspace shows no objects and loads nothing", async () => {
  useWorkspaces.setState({ workspaces: [workspace({ status: "disconnected" })] });
  await open(MOD_P);
  await screen.findByRole("dialog");
  expect(ipc.catalogGet).not.toHaveBeenCalled();
  expect(screen.queryAllByRole("option")).toHaveLength(0);
});

test("a catalog failure is shown in the palette", async () => {
  vi.mocked(ipc.catalogGet).mockRejectedValue({ kind: "io", message: "boom" });
  await open(MOD_K);
  expect(await screen.findByRole("alert")).toHaveTextContent("boom");
});

test("an action runs and closes the palette; unavailable actions are hidden", async () => {
  const user = await open(MOD_K);
  await screen.findByText("users");
  expect(screen.queryByText(strings.palette.action.format)).not.toBeInTheDocument();
  await user.click(screen.getByText(strings.palette.action.newQuery));
  expect(useWorkspaces.getState().workspaces[0].tabs).toHaveLength(2);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("Change schema opens a sub-list; Escape goes back, a pick applies setSchema", async () => {
  const user = await open(MOD_K);
  await user.click(await screen.findByText(strings.palette.action.changeSchema));
  await screen.findByText("audit");
  expect(screen.queryByText(strings.palette.actions)).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.getByText(strings.palette.actions)).toBeInTheDocument();
  await user.click(screen.getByText(strings.palette.action.changeSchema));
  await user.click(await screen.findByText("audit"));
  expect(useWorkspaces.getState().workspaces[0].currentSchema).toBe("audit");
});

test("Change database lists databasesList and Backspace on empty input goes back", async () => {
  vi.mocked(ipc.databasesList).mockResolvedValue(["app", "other"]);
  const user = await open(MOD_K);
  await user.click(await screen.findByText(strings.palette.action.changeDatabase));
  await screen.findByText("other");
  await user.keyboard("{Backspace}");
  expect(await screen.findByText(strings.palette.actions)).toBeInTheDocument();
  await user.click(screen.getByText(strings.palette.action.changeDatabase));
  vi.mocked(ipc.workspaceSwitchDatabase).mockResolvedValue({ database: "other" } as never);
  vi.mocked(ipc.schemasList).mockResolvedValue(["public"]);
  await user.click(await screen.findByText("other"));
  await waitFor(() => expect(ipc.workspaceSwitchDatabase).toHaveBeenCalledWith("w1", "other"));
});

test("selecting a connection opens it through the callback", async () => {
  const onOpen = vi.fn();
  const user = userEvent.setup();
  render(<CommandPalette onOpenConnection={onOpen} onNewConnection={vi.fn()} onShowWorkspace={vi.fn()} />);
  await user.keyboard(MOD_K);
  await user.click(await screen.findByText("Prod PG"));
  expect(onOpen).toHaveBeenCalledWith(conn);
});

test("selecting a tab activates it", async () => {
  useWorkspaces.setState({
    workspaces: [
      workspace({
        tabs: [
          { id: "q1", kind: "query", title: "Query 1", sql: "", sqlSessionId: null },
          { id: "q2", kind: "query", title: "Report", sql: "", sqlSessionId: null },
        ],
      }),
    ],
  });
  const user = await open(MOD_K);
  await user.click(await screen.findByText("Report"));
  expect(useWorkspaces.getState().workspaces[0].activeTabId).toBe("q2");
});

test("Escape returns focus to the element focused before opening", async () => {
  const btn = document.createElement("button");
  document.body.appendChild(btn);
  btn.focus();
  const user = await open(MOD_K);
  await screen.findByRole("dialog");
  await user.keyboard("{Escape}");
  expect(btn).toHaveFocus();
  btn.remove();
});

test("an action that focuses its own target keeps that focus", async () => {
  const btn = document.createElement("button");
  const editor = document.createElement("textarea");
  document.body.append(btn, editor);
  btn.focus();
  const off = registerEditorCommands("q1", { toggleComment: () => editor.focus() });
  const user = await open(MOD_K);
  await user.click(await screen.findByText(strings.palette.action.toggleComment));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await new Promise((r) => setTimeout(r, 10));
  expect(editor).toHaveFocus();
  off();
  btn.remove();
  editor.remove();
});

test("after selecting an object, focus is not left inside the removed dialog", async () => {
  const btn = document.createElement("button");
  document.body.appendChild(btn);
  btn.focus();
  const user = await open(MOD_P);
  await user.click(await screen.findByText("users"));
  await new Promise((r) => setTimeout(r, 10));
  expect(document.body.contains(document.activeElement)).toBe(true);
  expect(document.activeElement?.closest('[role="dialog"]')).toBeNull();
  expect(btn).toHaveFocus();
  btn.remove();
});
