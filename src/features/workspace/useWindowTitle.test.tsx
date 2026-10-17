import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import type { ConnectionConfig } from "../../lib/types";
import { useConnections } from "../../stores/connections";
import { useWindowTitle } from "./useWindowTitle";

vi.mock("../../lib/ipc");

beforeEach(() => {
  vi.resetAllMocks();
  useConnections.setState({ items: [] });
  vi.mocked(ipc.windowSetTitle).mockResolvedValue(undefined);
});

test("sets the title on activation and back to the app name without a workspace", () => {
  const { rerender } = renderHook(({ ws }) => useWindowTitle(ws), {
    initialProps: { ws: null as { connectionId: string; name: string; envTag: "prod" | "dev" } | null },
  });
  expect(ipc.windowSetTitle).toHaveBeenLastCalledWith("TableMax");
  rerender({ ws: { connectionId: "c1", name: "Shop", envTag: "prod" } });
  expect(ipc.windowSetTitle).toHaveBeenLastCalledWith("TableMax — Shop [PROD]");
  rerender({ ws: { connectionId: "c1", name: "Shop", envTag: "dev" } });
  expect(ipc.windowSetTitle).toHaveBeenLastCalledWith("TableMax — Shop");
  rerender({ ws: null });
  expect(ipc.windowSetTitle).toHaveBeenLastCalledWith("TableMax");
});

test("follows the live tag of the saved connection", () => {
  renderHook(() => useWindowTitle({ connectionId: "c1", name: "Shop", envTag: "dev" }));
  expect(ipc.windowSetTitle).toHaveBeenLastCalledWith("TableMax — Shop");
  act(() => useConnections.setState({ items: [{ id: "c1", envTag: "prod" } as ConnectionConfig] }));
  expect(ipc.windowSetTitle).toHaveBeenLastCalledWith("TableMax — Shop [PROD]");
});
