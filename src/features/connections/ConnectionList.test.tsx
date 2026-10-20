import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { strings } from "../../lib/strings";
import type { ConnectionConfig } from "../../lib/types";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { ConnectionList } from "./ConnectionList";

const make = (
  name: string,
  group: string | null,
  over: Partial<ConnectionConfig> = {},
): ConnectionConfig => ({
  id: name,
  name,
  color: "swatch-1",
  envTag: "local",
  kind: "postgres",
  host: "localhost",
  port: 5432,
  user: "u",
  database: null,
  sqlitePath: null,
  passwordMode: "keyring",
  group,
  ssl: { mode: "prefer", caFile: null, certFile: null, keyFile: null },
  ssh: null,
  ...over,
});

const items = [
  make("shop-prod", "Work", { envTag: "prod", host: "db.shop.example", database: "shop", color: "swatch-5" }),
  make("blog", "Personal", { host: "blog.example.com", kind: "mySql", port: 3306 }),
  make("scratch", null, { kind: "sqlite", host: "", port: 0, sqlitePath: "/data/scratch.db" }),
  make("shop-dev", "Work", { envTag: "dev", database: "shop_dev" }),
];

const handlers = () => ({
  onSelect: vi.fn(),
  onOpen: vi.fn(),
  onEdit: vi.fn(),
  onNew: vi.fn(),
});

const renderList = (list = items, selectedId: string | null = null, h = handlers()) => {
  const utils = render(<ConnectionList items={list} selectedId={selectedId} {...h} />);
  return { ...utils, h };
};

const row = (name: string) => screen.getByRole("option", { name: new RegExp(`^${name}\\b`) });
const groupButton = (name: string) => screen.getByRole("button", { name: strings.connections.groupToggle(name) });

beforeEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

test("groups_collapse_and_persist: disclosure buttons, alphabetical then Ungrouped, remembered", async () => {
  const user = userEvent.setup();
  const { unmount } = renderList();
  const headers = screen
    .getAllByRole("button", { name: /^Toggle group/ })
    .map((b) => b.getAttribute("aria-label"));
  expect(headers).toEqual(["Toggle group Personal", "Toggle group Work", "Toggle group Ungrouped"]);
  // Each group is a listbox named after it, controlled by its disclosure button.
  const work = groupButton("Work");
  expect(work).toHaveAttribute("aria-expanded", "true");
  const box = document.getElementById(work.getAttribute("aria-controls") ?? "");
  expect(box).toHaveAttribute("role", "listbox");
  expect(within(box as HTMLElement).getAllByRole("option")).toHaveLength(2);

  await user.click(work);
  expect(work).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("option", { name: /^shop-prod/ })).toBeNull();
  expect(row("blog")).toBeInTheDocument();
  unmount();

  renderList();
  expect(groupButton("Work")).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("option", { name: /^shop-prod/ })).toBeNull();
  await user.click(groupButton("Work"));
  expect(row("shop-prod")).toBeInTheDocument();
});

test("without any group the list is one flat listbox", () => {
  renderList([make("a", null), make("b", null)]);
  expect(screen.queryByRole("button", { name: /^Toggle group/ })).toBeNull();
  const box = screen.getByRole("listbox", { name: strings.connections.title });
  expect(within(box).getAllByRole("option")).toHaveLength(2);
});

test("row_shows_tile_tag_and_subtitle", () => {
  renderList();
  const prod = row("shop-prod");
  // 52 px rows with the engine tile, the colour dot, the name and the tag badge.
  expect(prod.className).toContain("h-13");
  expect(within(prod).getByText("Pg")).toHaveAttribute("aria-hidden", "true");
  expect(prod.querySelector("[data-color-dot]")?.className).toContain("bg-swatch-5-icon");
  expect(within(prod).getByText(strings.statusPill.tags.prod).className).toContain("bg-tag-prod-bg");
  // Subtitle: tag : host:port : database, in monospace.
  const subtitle = within(prod).getByText("prod : db.shop.example:5432 : shop");
  expect(subtitle.className).toContain("font-mono");
  // No database: the part is left out; MySQL tile.
  expect(within(row("blog")).getByText("local : blog.example.com:3306")).toBeInTheDocument();
  expect(within(row("blog")).getByText("My")).toBeInTheDocument();
  // SQLite: the file path.
  expect(within(row("scratch")).getByText("local : /data/scratch.db")).toBeInTheDocument();
  expect(within(row("scratch")).getByText("SL")).toBeInTheDocument();
});

test("search_filters_connections by name, group, host or database; collapsed groups open", async () => {
  const user = userEvent.setup();
  renderList();
  await user.click(groupButton("Work"));
  const search = screen.getByRole("searchbox", { name: strings.connections.searchLabel });
  await user.type(search, "work");
  expect(row("shop-prod")).toBeInTheDocument();
  expect(row("shop-dev")).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /^blog/ })).toBeNull();
  await user.clear(search);
  await user.type(search, "blog.example");
  expect(screen.getAllByRole("option").map((o) => o.getAttribute("aria-label"))).toEqual(["blog"]);
  await user.clear(search);
  await user.type(search, "shop_dev");
  expect(screen.getAllByRole("option").map((o) => o.getAttribute("aria-label"))).toEqual(["shop-dev"]);
  await user.clear(search);
  await user.type(search, "nothing like it");
  expect(screen.getByText(strings.connections.noMatch)).toBeInTheDocument();
});

test("Ctrl+F focuses the search; the + button asks for a new connection (Ctrl+N)", async () => {
  const user = userEvent.setup();
  const { h } = renderList();
  await user.keyboard("{Control>}f{/Control}");
  expect(screen.getByRole("searchbox")).toHaveFocus();
  const plus = screen.getByRole("button", { name: strings.connections.new });
  expect(plus).toHaveAttribute("data-tooltip-key", "Ctrl+N");
  await user.click(plus);
  expect(h.onNew).toHaveBeenCalled();
});

test("enter_connects: the focused row connects on Enter and on double-click", async () => {
  const user = userEvent.setup();
  const { h } = renderList(items, "blog");
  // One tab stop for the whole list: the selected row.
  expect(screen.getAllByRole("option").filter((o) => o.tabIndex === 0)).toEqual([row("blog")]);
  expect(row("blog")).toHaveAttribute("aria-selected", "true");
  row("blog").focus();
  await user.keyboard("{Enter}");
  expect(h.onOpen).toHaveBeenCalledWith(items[1]);
  await user.dblClick(row("scratch"));
  expect(h.onOpen).toHaveBeenLastCalledWith(items[2]);
  // A click only selects.
  await user.click(row("shop-dev"));
  expect(h.onSelect).toHaveBeenLastCalledWith(items[3]);
  expect(h.onOpen).toHaveBeenCalledTimes(2);
});

test("arrow keys move through the rows of every open group, Home and End too", async () => {
  const user = userEvent.setup();
  const { h, rerender } = renderList(items, "blog");
  row("blog").focus();
  // Order on screen: Personal (blog), Work (shop-dev, shop-prod), Ungrouped (scratch).
  await user.keyboard("{ArrowDown}");
  expect(h.onSelect).toHaveBeenLastCalledWith(items[3]);
  expect(row("shop-dev")).toHaveFocus();
  rerender(<ConnectionList items={items} selectedId="shop-dev" {...h} />);
  await user.keyboard("{End}");
  expect(row("scratch")).toHaveFocus();
  await user.keyboard("{Home}");
  expect(row("blog")).toHaveFocus();
  await user.keyboard("{ArrowUp}");
  expect(row("blog")).toHaveFocus();
});

test("the row menu connects or edits (right click, Shift+F10)", async () => {
  const user = userEvent.setup();
  const { h } = renderList();
  fireEvent.contextMenu(row("blog"));
  const menu = screen.getByRole("menu", { name: strings.connections.menuLabel });
  expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
    strings.connections.connect,
    strings.connections.edit,
  ]);
  await user.click(within(menu).getByRole("menuitem", { name: strings.connections.edit }));
  expect(h.onEdit).toHaveBeenCalledWith(items[1]);
  row("shop-dev").focus();
  await user.keyboard("{Shift>}{F10}{/Shift}");
  await user.click(screen.getByRole("menuitem", { name: strings.connections.connect }));
  expect(h.onOpen).toHaveBeenCalledWith(items[3]);
});

test("an empty list says so", () => {
  renderList([]);
  expect(screen.getByText(strings.connections.empty)).toBeInTheDocument();
});

test("a group name with spaces still names and controls its listbox", () => {
  renderList([make("a", "My Work"), make("b", null)]);
  const button = groupButton("My Work");
  const box = document.getElementById(button.getAttribute("aria-controls") ?? "");
  expect(box).toHaveAttribute("role", "listbox");
  expect(box).toHaveAccessibleName("My Work");
});
