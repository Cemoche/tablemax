import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import { useChrome } from "../../stores/chrome";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { SidebarFooter } from "./SidebarFooter";

vi.mock("../../lib/ipc");

const S = strings.sidebar;

const ws: Workspace = {
  id: "w1",
  connectionId: "c1",
  name: "PG",
  color: "swatch-1",
  envTag: "dev",
  dialect: "postgres",
  status: "connected",
  database: "app",
  schemas: ["public"],
  currentSchema: "public",
  tabs: [],
  activeTabId: null,
  mru: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ipc.catalogGet).mockResolvedValue({ schema: "public", tables: [] });
  useWorkspaces.setState({ workspaces: [ws], activeWorkspaceId: "w1" });
  useChrome.setState({ reloads: {} });
});

test("the ⌄ menu: New SQL query and Refresh; Escape closes it and gives the focus back", async () => {
  render(<SidebarFooter workspace={ws} />);
  const more = screen.getByRole("button", { name: S.more });
  await userEvent.click(more);
  expect(more).toHaveAttribute("aria-expanded", "true");
  expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([S.newQuery, S.refresh]);
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(more).toHaveFocus();
  await userEvent.click(more);
  await userEvent.click(screen.getByRole("menuitem", { name: S.refresh }));
  expect(useChrome.getState().reloads.w1).toBe(1);
  expect(ipc.catalogGet).toHaveBeenCalledWith("w1", "public", true);
  await userEvent.click(more);
  await userEvent.click(screen.getByRole("menuitem", { name: S.newQuery }));
  expect(useWorkspaces.getState().workspaces[0].tabs).toHaveLength(1);
});

test("a second click on ⌄ closes its menu (Task 11)", async () => {
  render(<SidebarFooter workspace={ws} />);
  const more = screen.getByRole("button", { name: S.more });
  await userEvent.click(more);
  expect(screen.getByRole("menu")).toBeInTheDocument();
  await userEvent.click(more);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(more).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(more);
  expect(screen.getByRole("menu")).toBeInTheDocument();
});

test("the schema picker is off when the connection lists no schema", () => {
  render(<SidebarFooter workspace={{ ...ws, schemas: [], currentSchema: null }} />);
  expect(screen.getByRole("combobox", { name: S.schema })).toBeDisabled();
});

test("a press outside the ⌄ menu gives the focus back only when nothing else took it", async () => {
  render(
    <>
      <SidebarFooter workspace={ws} />
      <input
        aria-label="editor stand-in"
        onMouseDown={(e) => {
          e.preventDefault();
          e.currentTarget.focus();
        }}
      />
    </>,
  );
  const more = screen.getByRole("button", { name: S.more });
  await userEvent.click(more);
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
  await waitFor(() => expect(more).toHaveFocus());
  await userEvent.click(more);
  const editor = screen.getByRole("textbox", { name: "editor stand-in" });
  fireEvent.mouseDown(editor);
  expect(screen.queryByRole("menu")).toBeNull();
  await act(() => new Promise((r) => setTimeout(r, 20)));
  expect(editor).toHaveFocus();
});
