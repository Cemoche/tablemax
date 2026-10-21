import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { CellValue, ResultSet, RowKey } from "../../lib/types";
import {
  ROW_DETAILS_DEFAULT,
  ROW_DETAILS_MIN,
  ROW_DETAILS_WIDTH_KEY,
  loadRowDetailsWidth,
  useChrome,
} from "../../stores/chrome";
import type { PendingTab } from "../../stores/pendingChanges";
import { col, tableInfo } from "../../test/tableInfo";
import { buildGridModel } from "./editModel";
import { RowDetailPanel } from "./RowDetailPanel";

vi.mock("../../lib/ipc");

const obj = { schema: "public", name: "order_lines" };
const int = (v: number): CellValue => ({ t: "int", v });
const info = tableInfo({
  columns: [...tableInfo().columns, col("doc", { typeName: "jsonb", baseType: "jsonb" })],
});
const names = ["order_id", "line", "id", "note", "total", "data", "doc"];
const RAW_JSON = '{"b":12345678901234567890123,"a":[1,2]}';
const PRETTY_JSON = '{\n  "b": 12345678901234567890123,\n  "a": [\n    1,\n    2\n  ]\n}';
const data = (over: Partial<Record<string, CellValue>> = {}): ResultSet => {
  const base: Record<string, CellValue> = {
    order_id: int(42),
    line: int(1),
    id: int(7),
    note: { t: "text", v: "hello" },
    total: { t: "decimal", v: "3.00" },
    data: { t: "bytes", v: { len: 2, hexPreview: "cafe" } },
    doc: { t: "json", v: RAW_JSON },
    ...over,
  };
  return {
    columns: names.map((name) => ({ name, typeName: "x" })),
    rows: [names.map((n) => base[n])],
    truncated: false,
  };
};
const key: RowKey = [
  ["order_id", int(42)],
  ["line", int(1)],
];

function renderPanel(
  d: ResultSet,
  opts: { pending?: PendingTab; locked?: boolean; row?: number | null; info?: typeof info } = {},
) {
  const onChange = vi.fn();
  const onAction = vi.fn();
  const onEscape = vi.fn();
  const onClose = vi.fn();
  const i = opts.info ?? info;
  const model = buildGridModel(d, i, opts.pending, opts.locked ?? false);
  const view = render(
    <RowDetailPanel
      workspaceId="w1"
      object={obj}
      data={d}
      info={i}
      model={model}
      row={opts.row === undefined ? 0 : opts.row}
      onChange={onChange}
      onAction={onAction}
      linksAt={() => []}
      onOpenLink={() => {}}
      onClose={onClose}
      onEscape={onEscape}
    />,
  );
  return { onChange, onAction, onEscape, onClose, view };
}

const field = (name: string) => screen.getByLabelText(name) as HTMLTextAreaElement;

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.removeItem(ROW_DETAILS_WIDTH_KEY);
  useChrome.setState({ rowDetailsWidth: ROW_DETAILS_DEFAULT });
});

test("no_row_selected_state: without a selected row it says so, with no field (the search stays)", () => {
  renderPanel(data(), { row: null });
  expect(screen.getByText(strings.grid.rowDetailsEmpty)).toBeInTheDocument();
  expect(strings.grid.rowDetailsEmpty).toBe("No row selected");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByRole("searchbox", { name: strings.grid.rowDetailsSearchLabel })).toBeInTheDocument();
});

test("while the page loads (no data or model yet) the panel is there, empty", () => {
  render(
    <RowDetailPanel
      workspaceId="w1"
      object={obj}
      data={null}
      info={null}
      model={null}
      row={null}
      onChange={() => {}}
      onAction={() => {}}
      linksAt={() => []}
      onOpenLink={() => {}}
      onClose={() => {}}
      onEscape={() => {}}
    />,
  );
  expect(screen.getByRole("complementary", { name: strings.grid.rowDetails })).toBeInTheDocument();
  expect(screen.getByText(strings.grid.rowDetailsEmpty)).toBeInTheDocument();
});

test("field_search_filters_fields: Search for field… keeps the fields whose name matches", async () => {
  renderPanel(data());
  const search = screen.getByRole("searchbox", { name: strings.grid.rowDetailsSearchLabel });
  expect(search).toHaveAttribute("placeholder", strings.grid.rowDetailsSearch);
  expect(strings.grid.rowDetailsSearch).toBe("Search for field…");
  await userEvent.type(search, "OT");
  // note and total match, case aside; the others are gone.
  expect(field("note")).toBeInTheDocument();
  expect(field("total")).toBeInTheDocument();
  expect(screen.queryByLabelText("doc")).toBeNull();
  expect(screen.queryByLabelText("order_id")).toBeNull();
  await userEvent.clear(search);
  await userEvent.type(search, "zzz");
  expect(screen.getByText(strings.grid.rowDetailsNoMatch)).toBeInTheDocument();
  await userEvent.clear(search);
  expect(screen.getAllByRole("textbox")).toHaveLength(names.length);
});

test("the panel is a labelled region; Escape in it hands the focus back to the grid", async () => {
  const { onEscape, onClose, onChange, onAction } = renderPanel(data());
  expect(screen.getByRole("complementary", { name: strings.grid.rowDetails })).toBeInTheDocument();
  await userEvent.type(field("note"), "!");
  await userEvent.keyboard("{Escape}");
  expect(onEscape).toHaveBeenCalledOnce();
  // What was typed stays pending: Escape only leaves the panel, it reverts nothing.
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenLastCalledWith(0, 3, { t: "text", v: "hello!" });
  expect(onAction).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("searchbox", { name: strings.grid.rowDetailsSearchLabel }));
  await userEvent.keyboard("{Escape}");
  expect(onEscape).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole("button", { name: strings.grid.rowDetailsClose }));
  expect(onClose).toHaveBeenCalledOnce();
});

test("a read-only table (a view, no key) shows read-only fields and no actions", () => {
  renderPanel(data(), { info: { ...info, kind: "view", rowKey: null } });
  for (const n of names) expect(field(n)).toHaveAttribute("readonly");
  expect(screen.queryByRole("button", { name: strings.grid.menu.setNull })).toBeNull();
});

test("panel_width_persists: 280 px by default, resized from its left edge by drag or keys, clamped and saved", () => {
  renderPanel(data());
  const aside = screen.getByRole("complementary", { name: strings.grid.rowDetails });
  expect(ROW_DETAILS_DEFAULT).toBe(280);
  expect(aside.style.width).toBe("280px");
  const edge = screen.getByRole("separator", { name: strings.grid.rowDetailsResize });
  expect(edge).toHaveAttribute("aria-valuenow", "280");
  expect(edge).toHaveAttribute("aria-valuemin", String(ROW_DETAILS_MIN));
  // The edge is on the left: moving it left widens the panel.
  fireEvent.keyDown(edge, { key: "ArrowLeft" });
  fireEvent.keyUp(edge, { key: "ArrowLeft" });
  expect(aside.style.width).toBe("290px");
  expect(edge).toHaveAttribute("aria-valuenow", "290");
  expect(localStorage.getItem(ROW_DETAILS_WIDTH_KEY)).toBe("290");
  // Dragged right past the minimum: clamped to 240, saved once at the end of the drag.
  fireEvent.pointerDown(edge, { button: 0, clientX: 500 });
  fireEvent.pointerMove(window, { clientX: 700 });
  expect(aside.style.width).toBe(`${ROW_DETAILS_MIN}px`);
  expect(localStorage.getItem(ROW_DETAILS_WIDTH_KEY)).toBe("290");
  fireEvent.pointerUp(window, { clientX: 700 });
  expect(localStorage.getItem(ROW_DETAILS_WIDTH_KEY)).toBe(String(ROW_DETAILS_MIN));
  // The next start reads it back.
  expect(loadRowDetailsWidth()).toBe(ROW_DETAILS_MIN);
  act(() => useChrome.setState({ rowDetailsWidth: loadRowDetailsWidth() }));
  expect(aside.style.width).toBe(`${ROW_DETAILS_MIN}px`);
  localStorage.setItem(ROW_DETAILS_WIDTH_KEY, "nonsense");
  expect(loadRowDetailsWidth()).toBe(ROW_DETAILS_DEFAULT);
});

test("shows every column with its type and value, JSON indented", () => {
  renderPanel(data());
  expect(screen.getByRole("complementary", { name: strings.grid.rowDetails })).toBeInTheDocument();
  expect(field("note").value).toBe("hello");
  expect(screen.getByText("jsonb")).toBeInTheDocument();
  expect(field("doc").value).toBe(PRETTY_JSON);
  expect(field("total").value).toBe("3.00");
});

test("a long text is loaded in full before it can be edited", async () => {
  vi.mocked(ipc.cellValue).mockResolvedValue({ t: "text", v: "the whole long text" });
  renderPanel(data({ note: { t: "longText", v: { preview: "the wh", len: 20000 } } }));
  expect(field("note")).toHaveAttribute("readonly");
  await waitFor(() => expect(field("note").value).toBe("the whole long text"));
  expect(ipc.cellValue).toHaveBeenCalledWith("w1", obj, key, "note");
  expect(field("note")).not.toHaveAttribute("readonly");
});

test("a truncated JSON is loaded in full and indented", async () => {
  vi.mocked(ipc.cellValue).mockResolvedValue({ t: "json", v: RAW_JSON });
  renderPanel(data({ doc: { t: "longText", v: { preview: '{"b":1', len: 9000 } } }));
  await waitFor(() => expect(field("doc").value).toBe(PRETTY_JSON));
  expect(ipc.cellValue).toHaveBeenCalledWith("w1", obj, key, "doc");
});

test("a failed load says why and keeps the field read-only", async () => {
  vi.mocked(ipc.cellValue).mockRejectedValue({ kind: "notFound", message: "row is gone" });
  renderPanel(data({ note: { t: "longText", v: { preview: "x", len: 20000 } } }));
  expect(await screen.findByText(strings.grid.editorLoadFailed("row is gone"))).toBeInTheDocument();
  expect(field("note")).toHaveAttribute("readonly");
});

test("typing sends the text as typed; untouched JSON is never rewritten", async () => {
  const { onChange, onAction } = renderPanel(data());
  await userEvent.click(field("doc"));
  await userEvent.tab();
  expect(onChange).not.toHaveBeenCalled();
  await userEvent.type(field("note"), "!");
  expect(onChange).toHaveBeenLastCalledWith(0, 3, { t: "text", v: "hello!" });
  await userEvent.type(field("doc"), " ");
  expect(onChange).toHaveBeenLastCalledWith(0, 6, { t: "text", v: `${PRETTY_JSON} ` });
  // Back to what was shown: the cell is reverted, not rewritten.
  await userEvent.type(field("doc"), "{Backspace}");
  expect(onAction).toHaveBeenLastCalledWith("revertCell", 0, 6);
});

test("a pending value is shown instead of the loaded one", () => {
  const pending: PendingTab = {
    edits: {
      [JSON.stringify(key)]: {
        key,
        set: { note: { t: "text", v: "edited" }, doc: { t: "null" } },
        original: data().rows[0],
      },
    },
    inserts: [],
    deletes: {},
    errors: {},
    error: null,
    refusal: null,
    outcomeUnknown: false,
    object: obj,
  };
  renderPanel(data(), { pending });
  expect(field("note").value).toBe("edited");
  expect(field("doc").value).toBe("");
  expect(field("doc")).toHaveAttribute("placeholder", strings.grid.nullText);
});

test("same rules as the grid: generated, binary and locked fields are read-only", () => {
  renderPanel(data());
  expect(field("total")).toHaveAttribute("readonly");
  expect(screen.getByText(strings.grid.generatedColumn)).toBeInTheDocument();
  expect(field("data")).toHaveAttribute("readonly");
  expect(screen.getByText(strings.grid.binaryReadOnly)).toBeInTheDocument();
  expect(field("note")).not.toHaveAttribute("readonly");
});

test("nothing is editable while a commit runs", () => {
  renderPanel(data(), { locked: true });
  expect(field("note")).toHaveAttribute("readonly");
  expect(screen.queryByRole("button", { name: strings.grid.menu.setNull })).toBeNull();
});

test("an edited field stays in the readable text while locked (#136: --text-2 is under 4.5:1 on --modified)", () => {
  const pending: PendingTab = {
    edits: {
      [JSON.stringify(key)]: { key, set: { note: { t: "text", v: "edited" } }, original: data().rows[0] },
    },
    inserts: [],
    deletes: {},
    errors: {},
    error: null,
    refusal: null,
    outcomeUnknown: false,
    object: obj,
  };
  renderPanel(data(), { pending, locked: true });
  expect(field("note")).toHaveAttribute("readonly");
  expect(field("note")).toHaveClass("bg-pending-edit", "text-fg");
  expect(field("note")).not.toHaveClass("text-muted");
  // A read-only field without an edit stays muted.
  expect(field("total")).toHaveClass("text-muted");
});

test("cell actions come from the grid's menu rules", async () => {
  const { onAction } = renderPanel(data());
  const buttons = screen.getAllByRole("button", { name: strings.grid.menu.setNull });
  // note and doc are nullable and editable; order_id/line are NOT NULL, total generated.
  expect(buttons).toHaveLength(2);
  await userEvent.click(buttons[0]);
  expect(onAction).toHaveBeenCalledWith("setNull", 0, 3);
});

test("typing back to an empty string set on a NULL column keeps the empty string", async () => {
  const d = data({ note: { t: "null" } });
  const pending: PendingTab = {
    edits: { [JSON.stringify(key)]: { key, set: { note: { t: "text", v: "" } }, original: d.rows[0] } },
    inserts: [],
    deletes: {},
    errors: {},
    error: null,
    refusal: null,
    outcomeUnknown: false,
    object: obj,
  };
  const { onChange, onAction } = renderPanel(d, { pending });
  await userEvent.type(field("note"), "a");
  expect(onChange).toHaveBeenLastCalledWith(0, 3, { t: "text", v: "a" });
  await userEvent.type(field("note"), "{Backspace}");
  expect(onChange).toHaveBeenLastCalledWith(0, 3, { t: "text", v: "" });
  expect(onAction).not.toHaveBeenCalled();
});

test("a NULL typed into and erased again goes back to NULL", async () => {
  const { onChange, onAction } = renderPanel(data({ note: { t: "null" } }));
  await userEvent.type(field("note"), "a{Backspace}");
  expect(onChange).toHaveBeenCalledWith(0, 3, { t: "text", v: "a" });
  expect(onAction).toHaveBeenLastCalledWith("revertCell", 0, 3);
});

test("a failed full-value load can be retried", async () => {
  vi.mocked(ipc.cellValue)
    .mockRejectedValueOnce({ kind: "connectionLost", message: "gone" })
    .mockResolvedValue({ t: "text", v: "full now" });
  renderPanel(data({ note: { t: "longText", v: { preview: "x", len: 20000 } } }));
  expect(await screen.findByText(strings.grid.editorLoadFailed("gone"))).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: strings.grid.retry }));
  await waitFor(() => expect(field("note").value).toBe("full now"));
  expect(ipc.cellValue).toHaveBeenCalledTimes(2);
});

test("a small content area caps the panel at 60 % of it, keeping the saved width for a wider window", () => {
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({ width: 500, height: 400, x: 0, y: 0, top: 0, left: 0, right: 500, bottom: 400, toJSON: () => ({}) });
  try {
    useChrome.setState({ rowDetailsWidth: 720 });
    renderPanel(data());
    const aside = screen.getByRole("complementary", { name: strings.grid.rowDetails });
    expect(aside.className).toContain("max-w-[60%]");
    expect(aside.style.width).toBe("300px");
    const edge = screen.getByRole("separator", { name: strings.grid.rowDetailsResize });
    expect(edge).toHaveAttribute("aria-valuenow", "300");
    expect(edge).toHaveAttribute("aria-valuemax", "300");
    expect(useChrome.getState().rowDetailsWidth).toBe(720);
    // Widening past the cap stays at the cap; narrowing starts from what is shown.
    fireEvent.keyDown(edge, { key: "ArrowLeft" });
    expect(aside.style.width).toBe("300px");
    fireEvent.keyDown(edge, { key: "ArrowRight" });
    expect(aside.style.width).toBe("290px");
    expect(useChrome.getState().rowDetailsWidth).toBe(290);
  } finally {
    rect.mockRestore();
  }
});

test("sql_result_row_read_only (#115): a SQL result row shows read-only fields, JSON indented, NULL as in the grid, a cut value said so", async () => {
  // What a SQL tab gives the panel: its result set, no table, no table info.
  const result: ResultSet = {
    columns: [
      { name: "id", typeName: "int4" },
      { name: "doc", typeName: "jsonb" },
      { name: "gone", typeName: "text" },
      { name: "body", typeName: "text" },
      // A query may return the same name twice.
      { name: "id", typeName: "int8" },
    ],
    rows: [
      [int(1), { t: "json", v: RAW_JSON }, { t: "null" }, { t: "longText", v: { preview: "the start", len: 90000 } }, int(2)],
      [int(3), { t: "json", v: "[]" }, { t: "text", v: "x" }, { t: "text", v: "short" }, int(4)],
    ],
    truncated: false,
  };
  const onEscape = vi.fn();
  const view = render(
    <RowDetailPanel
      workspaceId="w1"
      object={null}
      data={result}
      info={null}
      model={buildGridModel(result, null, undefined, false)}
      row={0}
      onClose={() => {}}
      onEscape={onEscape}
    />,
  );
  const boxes = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
  expect(boxes).toHaveLength(5);
  for (const b of boxes) expect(b).toHaveAttribute("readonly");
  expect(screen.getAllByLabelText("id").map((b) => (b as HTMLTextAreaElement).value)).toEqual(["1", "2"]);
  expect(screen.getByText("int8")).toBeInTheDocument();
  expect(field("doc").value).toBe(PRETTY_JSON);
  expect(screen.getByText("jsonb")).toBeInTheDocument();
  // NULL: an empty box with the grid's NULL placeholder.
  expect(field("gone").value).toBe("");
  expect(field("gone")).toHaveAttribute("placeholder", strings.grid.nullText);
  // A cut value: what the result has, and that it is only the start (no key to load it by).
  expect(field("body").value).toBe("the start…");
  expect(screen.getByText(strings.grid.quickLook.partial)).toBeInTheDocument();
  expect(ipc.cellValue).not.toHaveBeenCalled();
  // No cell action, no foreign key link.
  expect(screen.queryByRole("button", { name: strings.grid.menu.setNull })).toBeNull();
  // Typing does nothing: the field stays as it was.
  await userEvent.type(field("gone"), "abc");
  expect(field("gone").value).toBe("");
  // Another row: its fields.
  view.rerender(
    <RowDetailPanel
      workspaceId="w1"
      object={null}
      data={result}
      info={null}
      model={buildGridModel(result, null, undefined, false)}
      row={1}
      onClose={() => {}}
      onEscape={onEscape}
    />,
  );
  expect(field("gone").value).toBe("x");
  expect(field("body").value).toBe("short");
  expect(screen.queryByText(strings.grid.quickLook.partial)).toBeNull();
  // Escape in a field hands the focus back (to the results grid).
  field("body").focus();
  await userEvent.keyboard("{Escape}");
  expect(onEscape).toHaveBeenCalled();
});

test("a long text of a table row without a key says it is cut (nothing to load it by)", () => {
  renderPanel(data({ note: { t: "longText", v: { preview: "the wh", len: 20000 } } }), {
    info: { ...info, kind: "view", rowKey: null },
  });
  expect(field("note").value).toBe("the wh…");
  expect(screen.getByText(strings.grid.quickLook.partial)).toBeInTheDocument();
  expect(ipc.cellValue).not.toHaveBeenCalled();
});
