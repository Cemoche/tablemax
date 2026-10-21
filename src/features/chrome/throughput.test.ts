import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { THROUGHPUT_POLL_MS, formatRate, useThroughput } from "./throughput";

vi.mock("../../lib/ipc");

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("formatRate: B/s, KB/s, MB/s, GB/s with stable rounding (#112)", () => {
  expect(formatRate(0)).toBe("0 B/s");
  expect(formatRate(1)).toBe("1 B/s");
  expect(formatRate(999)).toBe("999 B/s");
  expect(formatRate(999.4)).toBe("999 B/s");
  // Rounding up to 1000 moves to the next unit, never "1000 B/s".
  expect(formatRate(999.6)).toBe("1.0 KB/s");
  expect(formatRate(1000)).toBe("1.0 KB/s");
  expect(formatRate(1234)).toBe("1.2 KB/s");
  expect(formatRate(9949)).toBe("9.9 KB/s");
  expect(formatRate(9950)).toBe("10 KB/s");
  expect(formatRate(12_345)).toBe("12 KB/s");
  expect(formatRate(999_400)).toBe("999 KB/s");
  expect(formatRate(999_600)).toBe("1.0 MB/s");
  expect(formatRate(3_400_000)).toBe("3.4 MB/s");
  expect(formatRate(250_000_000)).toBe("250 MB/s");
  expect(formatRate(1_200_000_000)).toBe("1.2 GB/s");
  expect(formatRate(5_000_000_000_000)).toBe("5000 GB/s");
  // Never a negative or broken number.
  expect(formatRate(-5)).toBe("0 B/s");
  expect(formatRate(Number.NaN)).toBe("0 B/s");
});

test("formatRate: at most 8 characters up to 999 GB/s, so a fixed slot never overflows", () => {
  for (let v = 1; v < 1e12; v *= 1.37) {
    expect(formatRate(v).length, formatRate(v)).toBeLessThanOrEqual(8);
  }
});

test("useThroughput polls the workspace while enabled and sums both directions", async () => {
  vi.mocked(ipc.workspaceThroughput)
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ readPerSec: 1000, writtenPerSec: 200 });
  const { result, rerender } = renderHook(({ id, on }) => useThroughput(id, on), {
    initialProps: { id: "w1", on: true },
  });
  // Asked at once, then every second.
  await act(async () => {});
  expect(ipc.workspaceThroughput).toHaveBeenCalledWith("w1");
  expect(result.current).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(THROUGHPUT_POLL_MS);
  });
  expect(result.current).toBe(1200);

  // Another workspace: its own rate only, never the previous one's.
  vi.mocked(ipc.workspaceThroughput).mockResolvedValue(null);
  rerender({ id: "w2", on: true });
  expect(result.current).toBeNull();
  await act(async () => {});
  expect(ipc.workspaceThroughput).toHaveBeenLastCalledWith("w2");
  expect(result.current).toBeNull();

  // Disabled: no more calls, no number.
  const calls = vi.mocked(ipc.workspaceThroughput).mock.calls.length;
  rerender({ id: "w2", on: false });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * THROUGHPUT_POLL_MS);
  });
  expect(vi.mocked(ipc.workspaceThroughput).mock.calls.length).toBe(calls);
  expect(result.current).toBeNull();
});

test("useThroughput shows nothing when the call fails, and stops polling on unmount", async () => {
  vi.mocked(ipc.workspaceThroughput).mockResolvedValueOnce({ readPerSec: 5, writtenPerSec: 0 });
  vi.mocked(ipc.workspaceThroughput).mockRejectedValue({ kind: "notFound", message: "workspace w1 not found" });
  const { result, unmount } = renderHook(() => useThroughput("w1", true));
  await act(async () => {});
  expect(result.current).toBe(5);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(THROUGHPUT_POLL_MS);
  });
  expect(result.current).toBeNull();
  unmount();
  const calls = vi.mocked(ipc.workspaceThroughput).mock.calls.length;
  await vi.advanceTimersByTimeAsync(5 * THROUGHPUT_POLL_MS);
  expect(vi.mocked(ipc.workspaceThroughput).mock.calls.length).toBe(calls);
});
