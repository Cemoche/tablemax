import { expect, test } from "vitest";
import { isMacPlatform, isModKey } from "./platform";

test("Mod is Cmd on macOS and Ctrl elsewhere", () => {
  expect(isMacPlatform("MacIntel", "")).toBe(true);
  expect(isMacPlatform("", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe(true);
  expect(isMacPlatform("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)")).toBe(false);
  expect(isMacPlatform("Win32", "")).toBe(false);
  const e = (ctrlKey: boolean, metaKey: boolean) => ({ ctrlKey, metaKey });
  expect(isModKey(e(true, false), false)).toBe(true);
  expect(isModKey(e(false, true), false)).toBe(false);
  expect(isModKey(e(false, true), true)).toBe(true);
  expect(isModKey(e(true, false), true)).toBe(false);
});
