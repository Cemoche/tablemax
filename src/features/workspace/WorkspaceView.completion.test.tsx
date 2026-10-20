import { completionStatus } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import type { CellValue, ResultSet } from "../../lib/types";
import { useCatalog } from "../../stores/catalog";
import { useChrome } from "../../stores/chrome";
import { usePendingChanges } from "../../stores/pendingChanges";
import { useQueryRuns } from "../../stores/queryRuns";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { tableInfo } from "../../test/tableInfo";
import { WorkspaceView } from "./WorkspaceView";

// The real SQL tabs and editors (CodeMirror) and the real table tabs, with the canvas
// grid stubbed: every switch below remounts the tab content as the app does.
vi.mock("../../lib/ipc");
vi.mock("../grid/DataGrid", () => ({ DataGrid: () => <div data-testid="grid" /> }));
vi.mock("../sidebar/Sidebar", () => ({ Sidebar: () => null, useSidebarShortcuts: () => {} }));
// CodeMirror measures text ranges, which jsdom does not lay out.
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}

const int = (v: number): CellValue => ({ t: "int", v });
const page: ResultSet = { columns: [{ name: "id", typeName: "int" }], rows: [[int(1)]], truncated: false };
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

beforeEach(() => {
  vi.resetAllMocks();
  const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  onTestFinished(() => spy.mockRestore());
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useChrome.setState(useChrome.getInitialState());
  useQueryRuns.setState({ runs: {} });
  useCatalog.setState({ catalogs: {}, errors: {}, loading: {} });
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
  vi.mocked(ipc.catalogGet).mockResolvedValue({
    schema: "public",
    tables: [{ name: "users", kind: "table", columns: [{ name: "email", typeName: "text" }] }],
  } as Awaited<ReturnType<typeof ipc.catalogGet>>);
  vi.mocked(ipc.tableInfo).mockResolvedValue(tableInfo());
  vi.mocked(ipc.tablePage).mockResolvedValue(page);
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 1 });
  vi.mocked(ipc.changesPreview).mockResolvedValue([]);
  useWorkspaces.setState({
    activeWorkspaceId: "w1",
    workspaces: [
      ws("w1", {
        tabs: [
          { id: "q1", kind: "query", title: "Query 1", sql: "select * from us", sqlSessionId: null },
          { id: "t1", kind: "table", object: { schema: "public", name: "users" }, title: "users", preview: false },
          { id: "q2", kind: "query", title: "Query 2", sql: "sel", sqlSessionId: null },
        ],
        activeTabId: "q1",
        mru: ["q1", "t1", "q2"],
      }),
      ws("w2", {
        tabs: [{ id: "q3", kind: "query", title: "Query 3", sql: "select * from users where em", sqlSessionId: null }],
        activeTabId: "q3",
        mru: ["q3"],
      }),
    ],
  });
});

/** The editor on screen, once mounted. */
async function editor(): Promise<EditorView> {
  let view: EditorView | null = null;
  await waitFor(() => {
    const content = document.querySelector(".cm-content");
    view = content ? EditorView.findFromDOM(content as HTMLElement) : null;
    expect(view).not.toBeNull();
  });
  return view as unknown as EditorView;
}

/** Ctrl+Space in the editor (cursor at the end) opens the completion list; Escape closes it. */
async function completionOpens(view: EditorView) {
  act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
  const rowDetails = useChrome.getState().rowDetailsOpen;
  const event = new KeyboardEvent("keydown", { key: " ", code: "Space", keyCode: 32, ctrlKey: true, bubbles: true, cancelable: true });
  act(() => {
    view.contentDOM.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
  await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
  // Ctrl+Space stays the editor's: the row detail panel did not move.
  expect(useChrome.getState().rowDetailsOpen).toBe(rowDetails);
  act(() => {
    fireEvent.keyDown(view.contentDOM, { key: "Escape", code: "Escape", keyCode: 27 });
  });
  expect(completionStatus(view.state)).toBeNull();
}

test("completion_after_tab_switch: Ctrl+Space opens the completion after tab and workspace switches", async () => {
  const user = userEvent.setup();
  render(<Live />);
  await completionOpens(await editor());

  // To the table tab and back (the editor is remounted).
  await user.click(screen.getByRole("tab", { name: /users/ }));
  await waitFor(() => expect(document.querySelector(".cm-content")).toBeNull());
  await user.click(screen.getByRole("tab", { name: /Query 1/ }));
  await completionOpens(await editor());

  // Another SQL tab, then back.
  await user.click(screen.getByRole("tab", { name: /Query 2/ }));
  await completionOpens(await editor());
  await user.click(screen.getByRole("tab", { name: /Query 1/ }));
  await completionOpens(await editor());

  // Another workspace, then back.
  act(() => useWorkspaces.getState().setActiveWorkspace("w2"));
  const other = await editor();
  expect(other.state.doc.toString()).toBe("select * from users where em");
  await completionOpens(other);
  act(() => useWorkspaces.getState().setActiveWorkspace("w1"));
  const back = await editor();
  expect(back.state.doc.toString()).toBe("select * from us");
  await completionOpens(back);
});

test("a SQL tab activated from the keyboard puts the focus in its editor, so Ctrl+Space works at once", async () => {
  const user = userEvent.setup();
  render(<Live />);
  const first = await editor();
  act(() => first.focus());
  // Ctrl+3 (tab.goto3): the focused editor goes away with its tab, the new one takes the focus.
  await user.keyboard("{Control>}3{/Control}");
  const second = await editor();
  expect(second.state.doc.toString()).toBe("sel");
  await waitFor(() => expect(second.hasFocus).toBe(true));

  // A click on a tab keeps the focus on the tab (the tab list stays usable from the keyboard).
  await user.click(screen.getByRole("tab", { name: /Query 1/ }));
  await editor();
  expect(screen.getByRole("tab", { name: /Query 1/ })).toHaveFocus();
});
