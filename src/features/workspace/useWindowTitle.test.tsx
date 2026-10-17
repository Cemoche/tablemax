import { renderHook } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { useWindowTitle } from "./useWindowTitle";

vi.mock("../../lib/ipc");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ipc.windowSetTitle).mockResolvedValue(undefined);
});

test("sets the title on activation and back to the app name without a workspace", () => {
  const { rerender } = renderHook(({ ws }) => useWindowTitle(ws), {
    initialProps: { ws: null as { name: string; envTag: "prod" | "dev" } | null },
  });
  expect(ipc.windowSetTitle).toHaveBeenLastCalledWith("TableMax");
  rerender({ ws: { name: "Shop", envTag: "prod" } });
  expect(ipc.windowSetTitle).toHaveBeenLastCalledWith("TableMax — Shop [PROD]");
  rerender({ ws: { name: "Shop", envTag: "dev" } });
  expect(ipc.windowSetTitle).toHaveBeenLastCalledWith("TableMax — Shop");
  rerender({ ws: null });
  expect(ipc.windowSetTitle).toHaveBeenLastCalledWith("TableMax");
});
