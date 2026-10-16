import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { useGridViews } from "../../stores/gridViews";
import { TableDataTab } from "./TableDataTab";

vi.mock("../../lib/ipc");
vi.mock("./DataGrid", () => ({ DataGrid: () => <div data-testid="grid" /> }));

const obj = { schema: "public", name: "users" };
const page = (n: number) => ({
  columns: [{ name: "id", typeName: "int" }],
  rows: Array.from({ length: n }, (_, i) => [{ t: "int" as const, v: i }]),
  truncated: false,
});

beforeEach(() => {
  vi.resetAllMocks();
  useGridViews.setState({ views: {} });
});

test("footer shows range with ≈ for estimates and pages forward", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(page(300));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "estimate", v: 1234567 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} />);
  await waitFor(() =>
    expect(screen.getByTestId("footer-range")).toHaveTextContent("Rows 1–300 of ≈ 1,234,567"),
  );
  await userEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() =>
    expect(screen.getByTestId("footer-range")).toHaveTextContent("Rows 301–600 of ≈ 1,234,567"),
  );
  expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
});

test("error shows message with Retry; connectionLost hints", async () => {
  vi.mocked(ipc.tablePage).mockRejectedValueOnce({ kind: "connectionLost", message: "server gone" });
  vi.mocked(ipc.tablePage).mockResolvedValue(page(1));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 1 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} />);
  expect(await screen.findByText("server gone")).toBeInTheDocument();
  expect(screen.getByText(/reopen the connection/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByTestId("footer-range")).toHaveTextContent("Rows 1–1 of 1");
});
