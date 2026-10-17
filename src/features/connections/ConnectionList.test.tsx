import { beforeEach, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConnectionConfig } from "../../lib/types";
import { ConnectionList } from "./ConnectionList";

const make = (name: string, group: string | null, host = "localhost"): ConnectionConfig => ({
  id: name,
  name,
  color: "swatch-1",
  envTag: "local",
  kind: "postgres",
  host,
  port: 5432,
  user: "u",
  database: null,
  sqlitePath: null,
  passwordMode: "keyring",
  group,
  ssl: { mode: "prefer", caFile: null, certFile: null, keyFile: null },
  ssh: null,
});

const items = [
  make("shop-prod", "Work"),
  make("blog", "Personal", "blog.example.com"),
  make("scratch", null),
  make("shop-dev", "Work"),
];

const renderList = () =>
  render(
    <ConnectionList
      items={items}
      selectedId={null}
      onSelect={vi.fn()}
      onOpen={vi.fn()}
      onNew={vi.fn()}
      onNewFromUrl={vi.fn()}
      onImport={vi.fn()}
    />,
  );

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

test("group headers are alphabetical, then Ungrouped", () => {
  renderList();
  const headers = screen.getAllByRole("button", { name: /^Toggle group/ }).map((b) => b.getAttribute("aria-label"));
  expect(headers).toEqual(["Toggle group Personal", "Toggle group Work", "Toggle group Ungrouped"]);
  expect(screen.getByText("scratch")).toBeInTheDocument();
});

test("clicking a header collapses its group and the state is remembered", async () => {
  const user = userEvent.setup();
  const { unmount } = renderList();
  await user.click(screen.getByRole("button", { name: /Work/ }));
  expect(screen.queryByText("shop-prod")).toBeNull();
  expect(screen.getByText("blog")).toBeInTheDocument();
  unmount();
  renderList();
  expect(screen.queryByText("shop-prod")).toBeNull();
  await user.click(screen.getByRole("button", { name: /Work/ }));
  expect(screen.getByText("shop-prod")).toBeInTheDocument();
});

test("searching a group name shows its connections, even collapsed", async () => {
  const user = userEvent.setup();
  renderList();
  await user.click(screen.getByRole("button", { name: /Work/ }));
  await user.type(screen.getByRole("searchbox"), "work");
  expect(screen.getByText("shop-prod")).toBeInTheDocument();
  expect(screen.getByText("shop-dev")).toBeInTheDocument();
  expect(screen.queryByText("blog")).toBeNull();
});

test("search also matches the host", async () => {
  const user = userEvent.setup();
  renderList();
  await user.type(screen.getByRole("searchbox"), "blog.example");
  expect(screen.getByText("blog")).toBeInTheDocument();
  expect(screen.queryByText("scratch")).toBeNull();
});

test("the + menu offers New connection, New from URL and the TablePlus import", async () => {
  const user = userEvent.setup();
  const onNew = vi.fn();
  const onNewFromUrl = vi.fn();
  const onImport = vi.fn();
  render(
    <ConnectionList
      items={[]}
      selectedId={null}
      onSelect={vi.fn()}
      onOpen={vi.fn()}
      onNew={onNew}
      onNewFromUrl={onNewFromUrl}
      onImport={onImport}
    />,
  );
  await user.click(screen.getByRole("button", { name: "New…" }));
  expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
    "New connection",
    "New from URL…",
    "Import TablePlus export…",
  ]);
  await user.click(screen.getByRole("menuitem", { name: "New from URL…" }));
  expect(onNewFromUrl).toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "New…" }));
  await user.click(screen.getByRole("menuitem", { name: "New connection" }));
  expect(onNew).toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "New…" }));
  await user.click(screen.getByRole("menuitem", { name: "Import TablePlus export…" }));
  expect(onImport).toHaveBeenCalled();
  expect(screen.queryByRole("menu")).toBeNull();
});

test("Escape closes the + menu and so does a click outside", async () => {
  const user = userEvent.setup();
  renderList();
  await user.click(screen.getByRole("button", { name: "New…" }));
  expect(screen.getByRole("menu")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  await user.click(screen.getByRole("button", { name: "New…" }));
  await user.click(screen.getByRole("searchbox"));
  expect(screen.queryByRole("menu")).toBeNull();
});
