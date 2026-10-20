import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { tip } from "../../lib/tooltip";
import { TOOLTIP_DELAY_MS, TOOLTIP_WARM_MS, TooltipLayer } from "./TooltipLayer";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const tooltip = () => screen.queryByRole("tooltip");

function setup(onKey = vi.fn<(key: string) => void>()) {
  render(
    <div onKeyDown={(e) => onKey(e.key)}>
      <TooltipLayer />
      <button type="button" aria-label="Filters" {...tip("Show or hide the filters", "Ctrl+F")}>
        F
      </button>
      <button type="button" aria-label="Columns" aria-describedby="own" {...tip("Choose the columns")}>
        <span>C</span>
      </button>
      <span id="own">own description</span>
      <button type="button">plain</button>
    </div>,
  );
  return {
    filters: screen.getByRole("button", { name: "Filters" }),
    columns: screen.getByRole("button", { name: "Columns" }),
    plain: screen.getByRole("button", { name: "plain" }),
    onKey,
  };
}

test("tooltip_delay: shows after the hover delay, with the label, the key and aria-describedby", () => {
  const { filters } = setup();
  fireEvent.mouseOver(filters);
  wait(TOOLTIP_DELAY_MS - 1);
  expect(tooltip()).toBeNull();
  wait(1);
  const t = screen.getByRole("tooltip");
  expect(t).toHaveTextContent("Show or hide the filters");
  expect(t.querySelector("kbd")).toHaveTextContent("Ctrl+F");
  expect(filters).toHaveAttribute("aria-describedby", t.id);
  // The accessible name stays the control's own.
  expect(filters).toHaveAccessibleName("Filters");
  expect(filters).toHaveAccessibleDescription("Show or hide the filters Ctrl+F");
  expect(t).toHaveAttribute("data-animate", "true");
});

test("tooltip_leave_and_warm: leaving hides at once; the next control within the warm time shows at once", () => {
  const { filters, columns, plain } = setup();
  fireEvent.mouseOver(filters);
  wait(TOOLTIP_DELAY_MS);
  fireEvent.mouseOut(filters, { relatedTarget: columns });
  expect(tooltip()).toBeNull();
  expect(filters).not.toHaveAttribute("aria-describedby");
  fireEvent.mouseOver(columns);
  const t = screen.getByRole("tooltip");
  expect(t).toHaveTextContent("Choose the columns");
  expect(t.querySelector("kbd")).toBeNull();
  // Shown at once: no entry animation either.
  expect(t).toHaveAttribute("data-animate", "false");
  // An existing description is kept.
  expect(columns.getAttribute("aria-describedby")?.split(" ")).toEqual(["own", t.id]);
  // Moving inside the control keeps it.
  fireEvent.mouseOut(columns, { relatedTarget: columns.firstChild });
  expect(tooltip()).not.toBeNull();
  fireEvent.mouseOut(columns, { relatedTarget: plain });
  expect(columns).toHaveAttribute("aria-describedby", "own");
  // Past the warm time, the delay is back.
  wait(TOOLTIP_WARM_MS + 1);
  fireEvent.mouseOver(filters);
  expect(tooltip()).toBeNull();
  wait(TOOLTIP_DELAY_MS);
  expect(tooltip()).not.toBeNull();
});

test("tooltip_leave_before_delay: no tooltip, and no warm state", () => {
  const { filters, columns } = setup();
  fireEvent.mouseOver(filters);
  wait(TOOLTIP_DELAY_MS - 50);
  fireEvent.mouseOut(filters, { relatedTarget: document.body });
  wait(100);
  expect(tooltip()).toBeNull();
  fireEvent.mouseOver(columns);
  expect(tooltip()).toBeNull();
});

test("tooltip_click: a press hides it, and it stays hidden until the pointer leaves the control", () => {
  const { filters } = setup();
  fireEvent.mouseOver(filters);
  wait(TOOLTIP_DELAY_MS);
  fireEvent.mouseDown(filters);
  expect(tooltip()).toBeNull();
  fireEvent.mouseOver(filters);
  wait(TOOLTIP_DELAY_MS * 2);
  expect(tooltip()).toBeNull();
  fireEvent.mouseOut(filters, { relatedTarget: document.body });
  wait(TOOLTIP_WARM_MS + 1);
  fireEvent.mouseOver(filters);
  wait(TOOLTIP_DELAY_MS);
  expect(tooltip()).not.toBeNull();
});

test("tooltip_escape: Escape closes a shown tooltip and goes no further; without one it passes", () => {
  const { filters, onKey } = setup();
  const windowKey = vi.fn();
  window.addEventListener("keydown", windowKey);
  fireEvent.mouseOver(filters);
  wait(TOOLTIP_DELAY_MS);
  filters.focus();
  fireEvent.keyDown(filters, { key: "Escape" });
  expect(tooltip()).toBeNull();
  expect(onKey).not.toHaveBeenCalled();
  expect(windowKey).not.toHaveBeenCalled();
  // Still hovered: it does not come back by itself.
  wait(TOOLTIP_DELAY_MS * 2);
  expect(tooltip()).toBeNull();
  // The next Escape is the page's.
  fireEvent.keyDown(filters, { key: "Escape" });
  expect(onKey).toHaveBeenCalledWith("Escape");
  expect(windowKey).toHaveBeenCalledTimes(1);
  window.removeEventListener("keydown", windowKey);
});

test("tooltip_escape_pending: Escape before the tooltip shows cancels it and passes on", () => {
  const { filters, onKey } = setup();
  fireEvent.mouseOver(filters);
  wait(TOOLTIP_DELAY_MS - 100);
  fireEvent.keyDown(filters, { key: "Escape" });
  expect(onKey).toHaveBeenCalledWith("Escape");
  wait(200);
  expect(tooltip()).toBeNull();
});

test("tooltip_keyboard_focus: Tab focus shows it at once; a pointer or a programmatic focus does not", () => {
  const { filters, columns, plain } = setup();
  act(() => plain.focus());
  fireEvent.keyDown(plain, { key: "Tab" });
  act(() => filters.focus());
  expect(screen.getByRole("tooltip")).toHaveTextContent("Show or hide the filters");
  expect(filters).toHaveAccessibleDescription("Show or hide the filters Ctrl+F");
  // Blur hides it.
  fireEvent.keyDown(filters, { key: "Tab" });
  act(() => plain.focus());
  expect(tooltip()).toBeNull();
  // A focus given back after Escape (or Enter) is not a keyboard move: no tooltip.
  fireEvent.keyDown(plain, { key: "Escape" });
  act(() => columns.focus());
  expect(tooltip()).toBeNull();
  // A press that focuses neither.
  fireEvent.mouseDown(filters);
  act(() => filters.focus());
  expect(tooltip()).toBeNull();
});

test("tooltip_typing: any other key hides it without being stopped", () => {
  const { filters, onKey } = setup();
  fireEvent.mouseOver(filters);
  wait(TOOLTIP_DELAY_MS);
  fireEvent.keyDown(filters, { key: "Shift" });
  expect(tooltip()).not.toBeNull();
  fireEvent.keyDown(filters, { key: "a" });
  expect(tooltip()).toBeNull();
  expect(onKey).toHaveBeenCalledWith("a");
});

function rect(top: number, left: number, width: number, height: number): DOMRect {
  return { top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}) };
}

test("tooltip_placement: below by default, above when the window ends, kept inside horizontally", () => {
  const { filters, columns } = setup();
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(800);
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === filters) return rect(100, 10, 30, 20);
    if (this === columns) return rect(570, 780, 20, 20);
    if (this.getAttribute("role") === "tooltip") return rect(0, 0, 120, 24);
    return rect(0, 0, 0, 0);
  });
  fireEvent.mouseOver(filters);
  wait(TOOLTIP_DELAY_MS);
  let t = screen.getByRole("tooltip");
  expect(t).toHaveAttribute("data-placement", "bottom");
  // Centered under the control (25 - 60 < 4: kept at the margin), below it with a gap.
  expect(t.style.left).toBe("4px");
  expect(parseFloat(t.style.top)).toBeGreaterThanOrEqual(120);
  fireEvent.mouseOut(filters, { relatedTarget: columns });
  fireEvent.mouseOver(columns);
  t = screen.getByRole("tooltip");
  // No room below: above, never over the control; no room right: moved left.
  expect(t).toHaveAttribute("data-placement", "top");
  expect(parseFloat(t.style.top) + 24).toBeLessThanOrEqual(570);
  expect(t.style.left).toBe(`${800 - 120 - 4}px`);
});

test("tooltip_reduced_motion: no entry animation", () => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("prefers-reduced-motion"), media: q }));
  const { filters } = setup();
  fireEvent.mouseOver(filters);
  wait(TOOLTIP_DELAY_MS);
  expect(screen.getByRole("tooltip")).toHaveAttribute("data-animate", "false");
});

test("tooltip_live: follows a label change, and goes with its control", async () => {
  const { filters } = setup();
  fireEvent.mouseOver(filters);
  wait(TOOLTIP_DELAY_MS);
  await act(async () => filters.setAttribute("data-tooltip", "Busy"));
  expect(screen.getByRole("tooltip")).toHaveTextContent("Busy");
  await act(async () => filters.remove());
  expect(tooltip()).toBeNull();
});

test("tip(): nothing without a label", () => {
  expect(tip("")).toEqual({});
  expect(tip(undefined, "Ctrl+F")).toEqual({});
  expect(tip("a", "")).toEqual({ "data-tooltip": "a" });
});
