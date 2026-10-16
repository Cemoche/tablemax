import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import type { ExecEvent } from "../../lib/types";
import { useQueryRuns } from "../../stores/queryRuns";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { QueryTab } from "./QueryTab";

vi.mock("../../lib/ipc");
vi.mock("../grid/DataGrid", () => ({
  DataGrid: ({ data, onSort }: { data: { rows: unknown[] }; onSort?: unknown }) => (
    <div data-testid="grid" data-rows={data.rows.length} data-sortable={String(!!onSort)} />
  ),
}));
vi.mock("./SqlEditor", () => ({
  SqlEditor: (p: {
    value: string;
    onChange: (v: string) => void;
    onRun: (mode: "current" | "all") => void;
  }) => (
    <textarea
      aria-label="SQL editor"
      value={p.value}
      onChange={(e) => p.onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key === "Enter") p.onRun(e.shiftKey ? "all" : "current");
      }}
    />
  ),
}));

const rs = (n: number) => ({
  columns: [{ name: "a", typeName: "int" }],
  rows: Array.from({ length: n }, (_, i) => [{ t: "int" as const, v: i }]),
});

let emit: (e: ExecEvent) => void;
let resolveExec: () => void;

const setup = async (sql = "select 1; select 2") => {
  useWorkspaces.setState({
    workspaces: [
      {
        id: "w1",
        connectionId: "c1",
        name: "n",
        color: "swatch-1",
        envTag: "dev",
        dialect: "postgres",
        schemas: ["public"],
        currentSchema: "public",
        tabs: [{ id: "t1", kind: "query", title: "Query 1", sql, sqlSessionId: null }],
        activeTabId: "t1",
      } satisfies Workspace,
    ],
    activeWorkspaceId: "w1",
  });
  const ws = useWorkspaces.getState().workspaces[0];
  const tab = ws.tabs[0];
  if (tab.kind !== "query") throw new Error("x");
  return render(<QueryTab workspace={ws} tab={tab} />);
};

beforeEach(() => {
  vi.resetAllMocks();
  useQueryRuns.setState({ runs: {} });
  vi.mocked(ipc.sqlSessionOpen).mockResolvedValue("s1");
  vi.mocked(ipc.sqlCancel).mockResolvedValue(undefined);
  vi.mocked(ipc.sqlExecute).mockImplementation((_s, _stmts, onEvent) => {
    emit = onEvent;
    return new Promise<void>((r) => {
      resolveExec = r;
    });
  });
});

test("run shows one result tab per result set and error with index", async () => {
  await setup("select 1; update t set a=1; select boom");
  await userEvent.click(screen.getByRole("button", { name: "Run all" }));
  await waitFor(() => expect(ipc.sqlExecute).toHaveBeenCalled());
  expect(ipc.sqlSessionOpen).toHaveBeenCalledWith("w1");
  expect(vi.mocked(ipc.sqlExecute).mock.calls[0][0]).toBe("s1");
  expect(vi.mocked(ipc.sqlExecute).mock.calls[0][1]).toEqual(["select 1", "update t set a=1", "select boom"]);
  expect(useWorkspaces.getState().workspaces[0].tabs[0]).toMatchObject({ sqlSessionId: "s1" });

  act(() => {
    emit({ event: "statementStarted", data: { index: 0 } });
    emit({
      event: "statementFinished",
      data: { index: 0, outcome: { result: rs(3), rowsAffected: null, elapsedMs: 7 } },
    });
    emit({
      event: "statementFinished",
      data: { index: 1, outcome: { result: null, rowsAffected: 5, elapsedMs: 2 } },
    });
    emit({
      event: "statementFailed",
      data: { index: 2, error: { kind: "query", message: "relation boom missing" } },
    });
    emit({ event: "batchFinished", data: { cancelled: false } });
  });

  expect(screen.getByRole("tab", { name: "Result 1" })).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "Result 2" })).toBeNull();
  expect(screen.getByTestId("grid")).toHaveAttribute("data-rows", "3");
  expect(screen.getByTestId("grid")).toHaveAttribute("data-sortable", "false");
  expect(screen.getByText("3 rows · 7 ms")).toBeInTheDocument();
  expect(screen.getByText("Statement 2: 5 rows affected (2 ms)")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Statement 3: relation boom missing");
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
});

test("a second Run reuses the session", async () => {
  await setup("select 1");
  await userEvent.click(screen.getByRole("button", { name: "Run all" }));
  await waitFor(() => expect(ipc.sqlExecute).toHaveBeenCalledTimes(1));
  act(() => emit({ event: "batchFinished", data: { cancelled: false } }));
  await userEvent.click(screen.getByRole("button", { name: "Run all" }));
  await waitFor(() => expect(ipc.sqlExecute).toHaveBeenCalledTimes(2));
  expect(ipc.sqlSessionOpen).toHaveBeenCalledTimes(1);
});

test("cancel button calls sqlCancel while running and disappears on batchFinished", async () => {
  await setup("select pg_sleep(10)");
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Run all" }));
  const cancel = await screen.findByRole("button", { name: "Cancel" });
  await userEvent.click(cancel);
  expect(ipc.sqlCancel).toHaveBeenCalledWith("s1");
  act(() => emit({ event: "batchFinished", data: { cancelled: true } }));
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  expect(screen.getByText("Cancelled")).toBeInTheDocument();
});

test("Ctrl+Enter runs the statement under the cursor, Ctrl+Shift+Enter everything", async () => {
  await setup("select 1; select 2");
  const ed = screen.getByLabelText("SQL editor");
  await userEvent.type(ed, "{Control>}{Enter}{/Control}");
  await waitFor(() => expect(ipc.sqlExecute).toHaveBeenCalledTimes(1));
  expect(vi.mocked(ipc.sqlExecute).mock.calls[0][1]).toEqual(["select 1"]);
  act(() => emit({ event: "batchFinished", data: { cancelled: false } }));
  await userEvent.type(ed, "{Control>}{Shift>}{Enter}{/Shift}{/Control}");
  await waitFor(() => expect(ipc.sqlExecute).toHaveBeenCalledTimes(2));
  expect(vi.mocked(ipc.sqlExecute).mock.calls[1][1]).toEqual(["select 1", "select 2"]);
});

test("rejected execute shows an index-less error and stops running", async () => {
  await setup("select 1");
  vi.mocked(ipc.sqlExecute).mockRejectedValueOnce({ kind: "invalid", message: "a query is already running" });
  await userEvent.click(screen.getByRole("button", { name: "Run all" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("a query is already running");
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
});

test("run state survives unmount/remount and events keep landing while unmounted", async () => {
  const { unmount } = await setup("select 1");
  await userEvent.click(screen.getByRole("button", { name: "Run all" }));
  await screen.findByRole("button", { name: "Cancel" });
  unmount();
  expect(useQueryRuns.getState().runs.t1.running).toBe(true);
  act(() => {
    emit({
      event: "statementFinished",
      data: { index: 0, outcome: { result: rs(1), rowsAffected: null, elapsedMs: 1 } },
    });
    emit({ event: "batchFinished", data: { cancelled: false } });
  });
  expect(useQueryRuns.getState().runs.t1.results).toHaveLength(1);
  expect(useQueryRuns.getState().runs.t1.running).toBe(false);
  resolveExec();
});

test("closing the tab while the session is opening closes the session and never executes", async () => {
  let resolveOpen: (id: string) => void = () => {};
  vi.mocked(ipc.sqlSessionOpen).mockImplementation(
    () => new Promise<string>((r) => (resolveOpen = r)),
  );
  vi.mocked(ipc.sqlSessionClose).mockResolvedValue(undefined);
  await setup("select 1");
  await userEvent.click(screen.getByRole("button", { name: "Run all" }));
  await waitFor(() => expect(ipc.sqlSessionOpen).toHaveBeenCalled());
  act(() => useWorkspaces.getState().closeTab("w1", "t1"));
  await act(async () => resolveOpen("s9"));
  expect(ipc.sqlSessionClose).toHaveBeenCalledWith("s9");
  expect(ipc.sqlExecute).not.toHaveBeenCalled();
  expect(useQueryRuns.getState().runs.t1).toBeUndefined();
});
