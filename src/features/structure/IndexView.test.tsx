import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { TableInfo } from "../../lib/types";
import { tableInfo } from "../../test/tableInfo";
import { IndexView } from "./IndexView";

vi.mock("../../lib/ipc");

const s = strings.structure;
const object = { schema: "public", name: "orders" };
const info: TableInfo = {
  ...tableInfo(),
  indexes: [
    {
      name: "orders_pkey",
      columns: ["id"],
      unique: true,
      primary: true,
      definition: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)",
    },
    {
      name: "orders_open_idx",
      columns: ["status", "created_at"],
      unique: false,
      primary: false,
      definition: "CREATE INDEX orders_open_idx ON public.orders USING hash (status) WHERE (status <> 'closed'::text)",
    },
    { name: "orders_user_uq", columns: ["user_id"], unique: true, primary: false, definition: null },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ipc.tableInfo).mockResolvedValue(info);
});

const row = (table: HTMLElement, name: string) => within(within(table).getByText(name).closest("tr")!);

test("index_view: name, columns, unique, type and condition of each index, from the cached table info", async () => {
  render(<IndexView workspaceId="w1" object={object} />);
  expect(screen.getByText(s.loading)).toBeInTheDocument();
  const table = await screen.findByRole("table", { name: s.indexView.label });
  expect(ipc.tableInfo).toHaveBeenCalledWith("w1", object, false);
  const headers = within(table)
    .getAllByRole("columnheader")
    .map((h) => h.textContent);
  expect(headers).toEqual([
    s.indexView.headers.name,
    s.indexView.headers.columns,
    s.indexView.headers.unique,
    s.indexView.headers.type,
    s.indexView.headers.condition,
  ]);
  const pk = row(table, "orders_pkey");
  expect(pk.getByText(s.primary)).toBeInTheDocument();
  expect(pk.getByText(s.yes)).toBeInTheDocument();
  expect(pk.getByText("btree")).toBeInTheDocument();
  const open = row(table, "orders_open_idx");
  expect(open.getByText("status, created_at")).toBeInTheDocument();
  expect(open.getByText(s.no)).toBeInTheDocument();
  expect(open.getByText("hash")).toBeInTheDocument();
  expect(open.getByText("(status <> 'closed'::text)")).toBeInTheDocument();
  // MySQL gives no definition: no type or condition to show.
  const uq = row(table, "orders_user_uq");
  expect(uq.getByText(s.yes)).toBeInTheDocument();
  expect(uq.queryByText(s.primary)).toBeNull();
});

test("no index: a message; Refresh reads the table info again from the database", async () => {
  vi.mocked(ipc.tableInfo).mockResolvedValue({ ...info, indexes: [] });
  render(<IndexView workspaceId="w1" object={object} />);
  expect(await screen.findByText(s.noIndexes)).toBeInTheDocument();
  vi.mocked(ipc.tableInfo).mockResolvedValue(info);
  await userEvent.click(screen.getByRole("button", { name: s.refresh }));
  expect(ipc.tableInfo).toHaveBeenLastCalledWith("w1", object, true);
  expect(await screen.findByRole("table", { name: s.indexView.label })).toBeInTheDocument();
});

test("a load error shows its message; a stale answer never replaces a newer one", async () => {
  let resolveFirst!: (v: TableInfo) => void;
  vi.mocked(ipc.tableInfo)
    .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
    .mockRejectedValueOnce({ kind: "query", message: "permission denied" });
  render(<IndexView workspaceId="w1" object={object} />);
  await userEvent.click(screen.getByRole("button", { name: s.refresh }));
  expect(await screen.findByRole("alert")).toHaveTextContent(s.loadFailed("permission denied"));
  await act(async () => resolveFirst(info));
  expect(screen.queryByRole("table")).toBeNull();
});
