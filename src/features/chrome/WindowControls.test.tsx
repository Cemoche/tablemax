import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import { useChrome } from "../../stores/chrome";
import { WindowControls } from "./WindowControls";

vi.mock("../../lib/ipc");

const w = strings.window;

const onPlatform = (platform: string) => vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);

beforeEach(() => {
  vi.resetAllMocks();
  useChrome.setState({ maximized: false });
});
afterEach(() => vi.restoreAllMocks());

const buttons = () => within(screen.getByRole("group", { name: w.controls })).getAllByRole("button");

test("window_controls_windows: flat 46 px caption buttons, close turns red with a white glyph (#104)", async () => {
  onPlatform("Win32");
  render(<WindowControls />);
  const group = screen.getByRole("group", { name: w.controls });
  expect(group).toHaveAttribute("data-window-style", "windows");
  expect(buttons().map((b) => b.getAttribute("aria-label"))).toEqual([w.minimize, w.maximize, w.close]);
  for (const b of buttons()) {
    // Windows caption buttons: 46 px wide, the bar's full height, square corners.
    expect(b.className).toContain("w-11.5");
    expect(b.className).toContain("self-stretch");
    expect(b.className).not.toContain("rounded-full");
  }
  const close = screen.getByRole("button", { name: w.close });
  expect(close.className).toContain("hover:bg-window-close");
  expect(close.className).toContain("hover:text-window-close-text");
  // Only close turns red.
  expect(screen.getByRole("button", { name: w.minimize }).className).not.toContain("bg-window-close");
  await userEvent.click(close);
  expect(ipc.windowClose).toHaveBeenCalled();
});

test("window_controls_linux: round GNOME-style buttons with full-size glyphs, no red close (#104)", () => {
  onPlatform("Linux x86_64");
  render(<WindowControls />);
  expect(screen.getByRole("group", { name: w.controls })).toHaveAttribute("data-window-style", "linux");
  for (const b of buttons()) {
    // 24 px circles (libadwaita), 16 px symbolic glyphs.
    expect(b.className).toContain("size-6");
    expect(b.className).toContain("rounded-full");
    expect(b.className).not.toContain("bg-window-close");
  }
  for (const name of [w.minimize, w.close]) {
    expect(screen.getByRole("button", { name }).querySelector("svg")).toHaveAttribute("width", "16");
  }
});

test("maximize shows Restore with its own glyph while maximized", () => {
  onPlatform("Win32");
  useChrome.setState({ maximized: true });
  render(<WindowControls />);
  const restore = screen.getByRole("button", { name: w.restore });
  expect(restore.querySelector("svg.lucide-copy")).not.toBeNull();
});
