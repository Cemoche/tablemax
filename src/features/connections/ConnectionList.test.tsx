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

test("the + menu offers New connection and New from URL", async () => {
  const user = userEvent.setup();
  const onNew = vi.fn();
  const onNewFromUrl = vi.fn();
  render(
    <ConnectionList items={[]} selectedId={null} onSelect={vi.fn()} onOpen={vi.fn()} onNew={onNew} onNewFromUrl={onNewFromUrl} />,
  );
  await user.click(screen.getByRole("button", { name: "New…" }));
  await user.click(screen.getByRole("menuitem", { name: "New from URL…" }));
  expect(onNewFromUrl).toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "New…" }));
  await user.click(screen.getByRole("menuitem", { name: "New connection" }));
  expect(onNew).toHaveBeenCalled();
});
