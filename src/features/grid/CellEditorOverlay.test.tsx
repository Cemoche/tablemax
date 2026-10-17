import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { strings } from "../../lib/strings";
import { CellEditorOverlay } from "./CellEditorOverlay";

test("edits the value and reports each change", async () => {
  const onChange = vi.fn();
  render(<CellEditorOverlay value="abc" onChange={onChange} />);
  const box = screen.getByRole("textbox", { name: strings.grid.editorLabel });
  expect(box).toHaveValue("abc");
  await userEvent.type(box, "d");
  expect(onChange).toHaveBeenLastCalledWith("abcd");
});

test("a truncated value is loaded in full before it can be edited", async () => {
  let resolve!: (s: string) => void;
  const load = vi.fn(() => new Promise<string>((r) => (resolve = r)));
  const onChange = vi.fn();
  render(<CellEditorOverlay value="preview" load={load} onChange={onChange} />);
  expect(screen.getByText(strings.grid.editorLoading)).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).toBeNull();
  resolve("x".repeat(50_000));
  const box = await screen.findByRole("textbox", { name: strings.grid.editorLabel });
  expect((box as HTMLTextAreaElement).value).toHaveLength(50_000);
  expect(onChange).not.toHaveBeenCalled();
});

test("a failed load never offers the preview for editing", async () => {
  const load = vi.fn(() => Promise.reject({ kind: "notFound", message: "the row changed" }));
  render(<CellEditorOverlay value="preview" load={load} onChange={vi.fn()} />);
  expect(await screen.findByText(strings.grid.editorLoadFailed("the row changed"))).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).toBeNull();
});

test("onMount runs when the editor opens and its cleanup when it closes", () => {
  const cleanup = vi.fn();
  const onMount = vi.fn(() => cleanup);
  const { unmount } = render(<CellEditorOverlay value="a" onChange={vi.fn()} onMount={onMount} />);
  expect(onMount).toHaveBeenCalledOnce();
  expect(cleanup).not.toHaveBeenCalled();
  unmount();
  expect(cleanup).toHaveBeenCalledOnce();
});
