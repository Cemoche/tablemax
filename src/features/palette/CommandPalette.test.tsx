import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { Catalog, ConnectionConfig } from "../../lib/types";
import { cleanKeymap } from "../settings/bounds";
import { useCatalog } from "../../stores/catalog";
import { useChrome } from "../../stores/chrome";
import { useConnections } from "../../stores/connections";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
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
/** The object items (Open Anything also lists tabs, connections and actions). */
const objectOptions = () =>
  screen.queryAllByRole("option").filter((o) => o.getAttribute("data-value")?.startsWith("object:"));

const open = async (chord: string) => {
  const user = userEvent.setup();
  render(<CommandPalette onOpenConnection={vi.fn()} onNewConnection={vi.fn()} onShowWorkspace={vi.fn()} />);
  await user.keyboard(chord);
  return user;
};

/** Opens Open Anything on its actions (the `>` prefix). */
const openActions = async () => {
  const user = await open(MOD_P);
  await user.type(await screen.findByRole("combobox"), ">");
  return user;
};

const MOD_P = "{Control>}p{/Control}";
const MOD_K = "{Control>}k{/Control}";

beforeEach(() => {
  vi.resetAllMocks();
  useCatalog.setState({ catalogs: {}, errors: {}, loading: {} });
  useConnections.setState({ items: [conn] });
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useWorkspaces.setState({ workspaces: [workspace()], activeWorkspaceId: "w1", sidebarVisible: true });
  useChrome.setState({ paletteRequest: null });
  vi.mocked(ipc.catalogGet).mockResolvedValue(catalog(["users", "orders", "order_items"]));
});

test("ctrl_p_opens_open_anything_objects: objects, tabs and connections in a modal dialog, no actions", async () => {
  await open(MOD_P);
  const dialog = await screen.findByRole("dialog", { name: strings.palette.label });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(screen.getByRole("combobox")).toHaveFocus();
  expect(screen.getByRole("combobox")).toHaveAttribute("placeholder", strings.palette.placeholder);
  await screen.findByText("users");
  for (const heading of [strings.palette.objects, strings.palette.tabs, strings.palette.connections]) {
    expect(within(dialog).getByText(heading)).toBeInTheDocument();
  }
  expect(within(dialog).getByText("Query 1")).toBeInTheDocument();
  expect(within(dialog).getByText("Prod PG")).toBeInTheDocument();
  // The actions wait for the ">" prefix.
  expect(within(dialog).queryByText(strings.palette.actions)).not.toBeInTheDocument();
  expect(within(dialog).queryByText(strings.palette.action.newQuery)).not.toBeInTheDocument();
  // Rows of 40 px (spec §2.3).
  for (const option of screen.getAllByRole("option")) expect(option).toHaveClass("h-10");
});

test("gt_prefix_lists_actions: > lists the actions only, the rest of the query narrows them", async () => {
  const user = await openActions();
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(strings.palette.actions)).toBeInTheDocument();
  expect(within(dialog).getByText(strings.palette.action.newQuery)).toBeInTheDocument();
  expect(within(dialog).getByText("Ctrl+T")).toBeInTheDocument();
  for (const heading of [strings.palette.objects, strings.palette.tabs, strings.palette.connections]) {
    expect(within(dialog).queryByText(heading)).not.toBeInTheDocument();
  }
  expect(within(dialog).queryByText("users")).not.toBeInTheDocument();
  // "> close" (a space after > is fine) keeps the matching actions.
  await user.type(screen.getByRole("combobox"), " close");
  expect(within(dialog).getByText(strings.palette.action.closeTab)).toBeInTheDocument();
  expect(within(dialog).queryByText(strings.palette.action.newQuery)).not.toBeInTheDocument();
  // Without the prefix, the same words search the objects.
  await user.clear(screen.getByRole("combobox"));
  await user.type(screen.getByRole("combobox"), "close");
  expect(within(dialog).queryByText(strings.palette.action.closeTab)).not.toBeInTheDocument();
});

test("show_connections_entry: > Show connections has Ctrl+Shift+K and shows the connection list (#119)", async () => {
  const onShowConnections = vi.fn();
  const user = userEvent.setup();
  render(
    <CommandPalette
      onOpenConnection={vi.fn()}
      onNewConnection={vi.fn()}
      onShowConnections={onShowConnections}
      onShowWorkspace={vi.fn()}
    />,
  );
  await user.keyboard(MOD_P);
  await user.type(await screen.findByRole("combobox"), ">show conn");
  const item = screen.getByText(strings.palette.action.showConnections).closest("[cmdk-item]") as HTMLElement;
  expect(within(item).getByText("Ctrl+Shift+K")).toBeInTheDocument();
  await user.click(item);
  expect(onShowConnections).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("old_palette_objects_remap_ignored: a saved palette.objects binding is dropped, Ctrl+K stays the database picker", async () => {
  const saved = cleanKeymap({ "palette.objects": "Mod+K", "palette.all": "Mod+P" });
  expect(saved).toEqual({ "palette.all": "Mod+P" });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: saved } });
  vi.mocked(ipc.databasesList).mockResolvedValue(["app", "other"]);
  await open(MOD_K);
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("combobox")).toHaveAttribute("placeholder", strings.palette.databasePlaceholder);
});

test("actions show their effective shortcut: a custom one replaces the default", async () => {
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, keymap: { "query.new": "Mod+Shift+N", "tab.close": "not a spec" } },
  });
  await openActions();
  const dialog = await screen.findByRole("dialog");
  const item = (title: string) => within(dialog).getByText(title).closest("[cmdk-item]") as HTMLElement;
  expect(within(item(strings.palette.action.newQuery)).getByText("Ctrl+Shift+N")).toBeInTheDocument();
  expect(within(dialog).queryByText("Ctrl+T")).not.toBeInTheDocument();
  // An invalid entry falls back to the default.
  expect(within(item(strings.palette.action.closeTab)).getByText("Ctrl+W")).toBeInTheDocument();
  // New connection has a keymap id since Task 8 (Ctrl+N)…
  expect(within(item(strings.palette.action.newConnection)).getByText("Ctrl+N")).toBeInTheDocument();
  // …and an action without a keymap id shows no shortcut.
  expect(item(strings.palette.action.reloadCatalog).querySelector("kbd")).toBeNull();
});

test("Escape closes and Mod+P toggles", async () => {
  const user = await open(MOD_P);
  await screen.findByRole("dialog");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.keyboard(MOD_P);
  await screen.findByRole("dialog");
  await user.keyboard(MOD_P);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("a custom palette combination opens and closes it; Mod+P no longer does", async () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "palette.all": "Alt+K" } } });
  const user = await open(MOD_P);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.keyboard("{Alt>}k{/Alt}");
  await screen.findByRole("dialog");
  // Over its own modal: the custom combination still toggles it.
  await user.keyboard("{Alt>}k{/Alt}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("ctrl_k_opens_database_picker", async () => {
  vi.mocked(ipc.databasesList).mockResolvedValue(["app", "other"]);
  const user = await open(MOD_K);
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("combobox")).toHaveAttribute("placeholder", strings.palette.databasePlaceholder);
  await screen.findByText("other");
  expect(within(dialog).queryByText(strings.palette.actions)).not.toBeInTheDocument();
  vi.mocked(ipc.workspaceSwitchDatabase).mockResolvedValue({ database: "other" } as never);
  vi.mocked(ipc.schemasList).mockResolvedValue(["public"]);
  await user.click(screen.getByText("other"));
  await waitFor(() => expect(ipc.workspaceSwitchDatabase).toHaveBeenCalledWith("w1", "other"));
});

test("Mod+K picks a schema where the database cannot be switched; nothing when disconnected", async () => {
  useWorkspaces.setState({ workspaces: [workspace({ dialect: "mySql", capabilities: undefined })] });
  const user = await open(MOD_K);
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("combobox")).toHaveAttribute("placeholder", strings.palette.schemaPlaceholder);
  await user.click(await screen.findByText("audit"));
  expect(useWorkspaces.getState().workspaces[0].currentSchema).toBe("audit");

  useWorkspaces.setState({ workspaces: [workspace({ status: "disconnected" })] });
  await user.keyboard(MOD_K);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("the toolbar's Open Anything and database buttons open the palette", async () => {
  vi.mocked(ipc.databasesList).mockResolvedValue(["app", "other"]);
  render(<CommandPalette onOpenConnection={vi.fn()} onNewConnection={vi.fn()} onShowWorkspace={vi.fn()} />);
  act(() => useChrome.getState().requestPalette("all"));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("combobox")).toHaveAttribute("placeholder", strings.palette.placeholder);
  await userEvent.setup().keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  act(() => useChrome.getState().requestPalette("database"));
  expect(await screen.findByText("other")).toBeInTheDocument();
});

test("it does not open over another modal dialog", async () => {
  render(
    <>
      <div role="dialog" aria-modal="true" />
      <CommandPalette onOpenConnection={vi.fn()} onNewConnection={vi.fn()} onShowWorkspace={vi.fn()} />
    </>,
  );
  await userEvent.setup().keyboard(MOD_P);
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
  await waitFor(() => expect(objectOptions().length).toBeGreaterThan(0));
  expect(objectOptions().length).toBeLessThanOrEqual(200);
  await user.type(input, "tbl_4");
  await waitFor(() => expect(firstName()).toBe("tbl_4"));
  expect(objectOptions().length).toBeLessThanOrEqual(200);
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
  expect(objectOptions()).toHaveLength(0);
});

test("a catalog failure is shown in the palette", async () => {
  vi.mocked(ipc.catalogGet).mockRejectedValue({ kind: "io", message: "boom" });
  await open(MOD_P);
  expect(await screen.findByRole("alert")).toHaveTextContent("boom");
});

test("an action runs and closes the palette; unavailable actions are hidden", async () => {
  const user = await openActions();
  expect(screen.queryByText(strings.palette.action.format)).not.toBeInTheDocument();
  await user.click(screen.getByText(strings.palette.action.newQuery));
  expect(useWorkspaces.getState().workspaces[0].tabs).toHaveLength(2);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("Change schema opens a sub-list; Escape goes back to the actions, a pick applies setSchema", async () => {
  const user = await openActions();
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
  const user = await openActions();
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
  await user.keyboard(MOD_P);
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
  const user = await open(MOD_P);
  await user.click(await screen.findByText("Report"));
  expect(useWorkspaces.getState().workspaces[0].activeTabId).toBe("q2");
});

test("Escape returns focus to the element focused before opening", async () => {
  const btn = document.createElement("button");
  document.body.appendChild(btn);
  btn.focus();
  const user = await open(MOD_P);
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
  const user = await openActions();
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
