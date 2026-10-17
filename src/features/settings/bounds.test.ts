import { expect, test } from "vitest";
import { isValidFontFamily } from "./bounds";

test("font family accepts plain and quoted comma-separated names", () => {
  for (const ok of [
    "",
    "Fira Code",
    '"Fira Code", monospace',
    "JetBrains Mono, monospace",
    "'Source Code Pro',monospace",
    "my_font-2",
    "a".repeat(200),
  ]) {
    expect(isValidFontFamily(ok), ok).toBe(true);
  }
});

test("font family rejects CSS syntax, stray quotes and overlong text", () => {
  for (const bad of [
    "x; } .a { color: red",
    "url(x)",
    "a:b",
    '"Fira',
    "'Fira\"",
    "Fira'",
    "a/b",
    "a\\b",
    "<b>",
    "a{b}",
    "a,,b",
    "a,",
    "   ",
    '""',
    '"a"b',
    "Fira\nCode",
    "Fíra",
    "a".repeat(201),
  ]) {
    expect(isValidFontFamily(bad), bad).toBe(false);
  }
});
