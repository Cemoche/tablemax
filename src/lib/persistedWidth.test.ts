import { afterEach, expect, test, vi } from "vitest";
import { persistedWidth } from "./persistedWidth";

const w = persistedWidth("test.width", 300, 200, 600);
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem("test.width");
});

test("clamps and rounds, loads what was saved, falls back to the default", () => {
  expect(w.clamp(10)).toBe(200);
  expect(w.clamp(9999)).toBe(600);
  expect(w.clamp(250.6)).toBe(251);
  expect(w.load()).toBe(300);
  w.save(420);
  expect(localStorage.getItem("test.width")).toBe("420");
  expect(w.load()).toBe(420);
  localStorage.setItem("test.width", "nope");
  expect(w.load()).toBe(300);
  localStorage.setItem("test.width", "12");
  expect(w.load()).toBe(200);
});

test("storage failures keep the default and never throw", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  expect(w.load()).toBe(300);
  expect(() => w.save(400)).not.toThrow();
});
