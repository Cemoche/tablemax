import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { __setNonLatinLayoutForTests } from "../lib/shortcuts";

afterEach(() => {
  cleanup();
  // The layout tracker's state is module-wide: each test starts on a Latin layout (#131).
  __setNonLatinLayoutForTests(false);
});

// cmdk measures its list with ResizeObserver and scrolls the selected item into view;
// jsdom has neither.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
