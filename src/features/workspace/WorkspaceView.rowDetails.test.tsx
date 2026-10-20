import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { CellValue, ResultSet } from "../../lib/types";
import { useChrome } from "../../stores/chrome";
import { usePendingChanges } from "../../stores/pendingChanges";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { tableInfo } from "../../test/tableInfo";
import type { DataGridProps } from "../grid/DataGrid";
import { WorkspaceView } from "./WorkspaceView";

// The real table tabs (their row details and shortcuts), with the canvas grid stubbed.
vi.mock("../../lib/ipc");
let grid: DataGridProps | null = null;
vi.mock("../grid/DataGrid", () => ({
  DataGrid: (p: DataGridProps) => {
    grid = p;
    return <div data-testid="grid" />;
  },
}));
vi.mock("../sidebar/Sidebar", () => ({ Sidebar: () => null, useSidebarShortcuts: () => {} }));
vi.mock("../editor/QueryTab", () => ({ QueryTab: () => <div data-testid="query-tab" /> }));

const users = { schema: "public", name: "users" };
const orders = { schema: "public", name: "orders" };
const items = { schema: "public", name: "items" };
const int = (v: number): CellValue => ({ t: "int", v });
const names = ["id", "order_id", "line", "note", "total", "data"];
const page: ResultSet = {
  columns: names.map((name) => ({ name, typeName: "x" })),
  rows: [0, 1].map((i) => [int(100 + i), int(42), int(i), { t: "text", v: `note ${i}` }, { t: "decimal", v: "1" }, { t: "null" }]),
  truncated: false,
};
const ws = (id: string, over: Partial<Workspace>): Workspace => ({
  id,
  connectionId: `c-${id}`,
  name: id,
  color: "swatch-1",
  envTag: "local",
  dialect: "postgres",
  status: "connected",
  database: null,
  schemas: ["public"],
  currentSchema: "public",
  tabs: [],
  activeTabId: null,
  mru: [],
  ...over,
});

/** The active workspace, remounted on a switch as App does (`key`). */
function Live() {
  const w = useWorkspaces((s) => s.workspaces.find((x) => x.id === s.activeWorkspaceId));
  return w ? <WorkspaceView key={w.id} workspace={w} /> : null;
}

const panel = () => screen.queryByRole("complementary", { name: strings.grid.rowDetails });
const shown = () => panel() !== null;

beforeEach(() => {
  vi.resetAllMocks();
  const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  onTestFinished(() => spy.mockRestore());
  grid = null;
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useChrome.setState(useChrome.getInitialState());
  usePendingChanges.setState({
    tabs: {},
    blocked: {},
    committing: {},
    committingIn: {},
    confirming: {},
    applied: {},
    editorOpen: {},
    awaitingReload: {},
    epoch: {},
  });
  vi.mocked(ipc.tableInfo).mockResolvedValue(tableInfo());
  vi.mocked(ipc.tablePage).mockResolvedValue(page);
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  vi.mocked(ipc.changesPreview).mockResolvedValue([]);
  useWorkspaces.setState({
    activeWorkspaceId: "w1",
    workspaces: [
      ws("w1", {
        tabs: [
          { id: "t1", kind: "table", object: users, title: "users", preview: false },
          { id: "t2", kind: "table", object: orders, title: "orders", preview: false },
          { id: "q1", kind: "query", title: "Query 1", sql: "", sqlSessionId: null },
        ],
        activeTabId: "t1",
        mru: ["t1", "t2", "q1"],
      }),
      ws("w2", {
        tabs: [{ id: "t3", kind: "table", object: items, title: "items", preview: false }],
        activeTabId: "t3",
        mru: ["t3"],
      }),
    ],
  });
});

/** Ctrl+Space from wherever the focus is, and the panel flipped. */
async function ctrlSpaceToggles(user: ReturnType<typeof userEvent.setup>) {
  const before = shown();
  await user.keyboard("{Control>} {/Control}");
  expect(shown()).toBe(!before);
  await user.keyboard("{Control>} {/Control}");
  expect(shown()).toBe(before);
}

/** The tab's grid is there and ready to edit (its page and table info loaded). */
const gridReady = () => waitFor(() => expect(grid?.editing).toBeTruthy());

test("ctrl_space_after_tab_switch (#79): Ctrl+Space toggles the panel every time, after tab and workspace switches", async () => {
  const user = userEvent.setup();
  render(<Live />);
  await gridReady();
  await ctrlSpaceToggles(user);

  grid = null;
  await user.click(screen.getByRole("tab", { name: /orders/ }));
  await gridReady();
  await ctrlSpaceToggles(user);

  grid = null;
  await user.click(screen.getByRole("tab", { name: /users/ }));
  await gridReady();
  await ctrlSpaceToggles(user);
  // From the grid (it has the focus after a row click): Space too.
  act(() => grid!.onToggleDetails!());
  const afterSpace = shown();
  await user.keyboard("{Control>} {/Control}");
  expect(shown()).toBe(!afterSpace);

  grid = null;
  act(() => useWorkspaces.getState().setActiveWorkspace("w2"));
  await gridReady();
  await ctrlSpaceToggles(user);

  grid = null;
  act(() => useWorkspaces.getState().setActiveWorkspace("w1"));
  await gridReady();
  await ctrlSpaceToggles(user);
});

test("the panel stays open across tab and workspace switches (one panel for the window, like the toolbar button)", async () => {
  const user = userEvent.setup();
  render(<Live />);
  await gridReady();
  await user.keyboard("{Control>} {/Control}");
  expect(shown()).toBe(true);

  grid = null;
  await user.click(screen.getByRole("tab", { name: /orders/ }));
  await gridReady();
  expect(shown()).toBe(true);

  grid = null;
  act(() => useWorkspaces.getState().setActiveWorkspace("w2"));
  await gridReady();
  expect(shown()).toBe(true);
  await user.keyboard("{Control>} {/Control}");
  expect(shown()).toBe(false);

  grid = null;
  act(() => useWorkspaces.getState().setActiveWorkspace("w1"));
  await gridReady();
  expect(shown()).toBe(false);
});

test("in a SQL tab Ctrl+Space is not the panel's: nothing is bound to it there (the editor keeps its completion)", async () => {
  const user = userEvent.setup();
  render(<Live />);
  await gridReady();
  await user.click(screen.getByRole("tab", { name: /Query 1/ }));
  expect(screen.getByTestId("query-tab")).toBeInTheDocument();
  const before = JSON.stringify(useChrome.getState());
  const ctrlSpace = new KeyboardEvent("keydown", { code: "Space", key: " ", ctrlKey: true, bubbles: true, cancelable: true });
  act(() => {
    window.dispatchEvent(ctrlSpace);
  });
  // Not prevented: CodeMirror (which sees it first) and the system get it untouched.
  expect(ctrlSpace.defaultPrevented).toBe(false);
  expect(JSON.stringify(useChrome.getState())).toBe(before);
});
