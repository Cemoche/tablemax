import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { strings } from "../../lib/strings";
import { QuickLook, quickLookText } from "./QuickLook";

test("quickLookText: JSON indented, text kept, placeholders flagged", () => {
  expect(quickLookText({ t: "json", v: '{"a":[1,2]}' }).text).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
  // JSON stored in a text column is indented too; other text is left as is.
  expect(quickLookText({ t: "text", v: ' {"k":1}' }).text).toContain('"k": 1');
  expect(quickLookText({ t: "text", v: "line 1\nline 2" }).text).toBe("line 1\nline 2");
  expect(quickLookText({ t: "null" })).toEqual({ text: "NULL", placeholder: true });
  expect(quickLookText({ t: "text", v: "" })).toEqual({ text: "EMPTY", placeholder: true });
  expect(quickLookText("default")).toEqual({ text: "DEFAULT", placeholder: true });
  expect(quickLookText({ t: "bigInt", v: "9223372036854775807" }).text).toBe("9223372036854775807");
});

test("a truncated value says so when it cannot be loaded, and shows a load failure", async () => {
  const long = { t: "longText" as const, v: { preview: "abc", len: 99999 } };
  const view = render(<QuickLook column="note" value={long} onClose={vi.fn()} />);
  expect(screen.getByRole("status")).toHaveTextContent(strings.grid.quickLook.partial);
  expect(screen.getByRole("dialog", { name: strings.grid.quickLook.title("note") })).toHaveTextContent("abc");
  view.unmount();
  render(
    <QuickLook column="note" value={long} load={() => Promise.reject({ kind: "io", message: "gone" })} onClose={vi.fn()} />,
  );
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(strings.grid.quickLook.failed("gone")));
});

test("the value has the focus; Tab moves between it and Close; Escape closes", async () => {
  const onClose = vi.fn();
  render(<QuickLook column="doc" value={{ t: "text", v: "x" }} onClose={onClose} />);
  const body = screen.getByText("x");
  expect(body).toHaveFocus();
  await userEvent.tab();
  expect(screen.getByRole("button", { name: strings.grid.quickLook.close })).toHaveFocus();
  await userEvent.tab();
  expect(body).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledOnce();
});
