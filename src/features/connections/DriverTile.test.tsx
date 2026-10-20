import { expect, test } from "vitest";
import { render } from "@testing-library/react";
import type { DriverKind } from "../../lib/types";
import { DriverTile, driverTile } from "./DriverTile";

test("each engine of the form has its own monogram and tile colour", () => {
  const kinds: DriverKind[] = ["postgres", "mySql", "mariaDb", "sqlite"];
  expect(kinds.map((k) => driverTile(k).monogram)).toEqual(["Pg", "My", "Ma", "SL"]);
  const classes = kinds.map((k) => driverTile(k).className);
  expect(new Set(classes).size).toBe(kinds.length);
  for (const c of classes) expect(c).toMatch(/^bg-driver-[a-z]+ text-driver-[a-z]+-text$/);
});

test("an engine without its own tile gets a neutral one with the start of its name", () => {
  // MongoDB has no tile of its own yet (paused branch): one map entry adds it.
  expect(driverTile("mongoDb")).toEqual({ monogram: "Mo", className: "bg-driver-other text-driver-other-text" });
});

test("the tile is decorative: the row says the engine in its name", () => {
  const { container } = render(<DriverTile kind="postgres" />);
  const tile = container.firstElementChild as HTMLElement;
  expect(tile).toHaveAttribute("aria-hidden", "true");
  expect(tile).toHaveTextContent("Pg");
  expect(tile.className).toContain("bg-driver-pg");
});
