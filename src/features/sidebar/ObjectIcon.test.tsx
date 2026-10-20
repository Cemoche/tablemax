import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { strings } from "../../lib/strings";
import { OBJECT_ICON_KINDS, ObjectIcon } from "./ObjectIcon";

test("tree_icons_by_kind: one named, distinct icon per object kind", () => {
  expect(OBJECT_ICON_KINDS).toEqual(["table", "view", "materializedView", "function", "procedure"]);
  const drawings = new Set<string>();
  for (const kind of OBJECT_ICON_KINDS) {
    const { unmount } = render(<ObjectIcon kind={kind} />);
    const icon = screen.getByRole("img", { name: strings.sidebar.kinds[kind] });
    expect(icon.tagName.toLowerCase()).toBe("svg");
    expect(icon).toHaveAttribute("data-kind", kind);
    // Monochrome strokes in the current color (themes come from the parent's text token).
    expect(icon.getAttribute("stroke")).toBe("currentColor");
    drawings.add(icon.innerHTML);
    unmount();
  }
  expect(drawings.size).toBe(OBJECT_ICON_KINDS.length);
});
