import { expect, test, vi } from "vitest";
import { hasEditorCommand, registerEditorCommands, runEditorCommand } from "./editorCommands";

test("registered commands are found and run per tab", () => {
  const toggle = vi.fn();
  const off = registerEditorCommands("t1", { toggleComment: toggle });
  expect(hasEditorCommand("t1", "toggleComment")).toBe(true);
  expect(hasEditorCommand("t1", "format")).toBe(false);
  expect(hasEditorCommand("t2", "toggleComment")).toBe(false);
  expect(runEditorCommand("t1", "toggleComment")).toBe(true);
  expect(toggle).toHaveBeenCalledTimes(1);
  expect(runEditorCommand("t1", "format")).toBe(false);
  off();
  expect(hasEditorCommand("t1", "toggleComment")).toBe(false);
  expect(runEditorCommand("t1", "toggleComment")).toBe(false);
});

test("an old cleanup does not drop a newer registration of the same tab", () => {
  const offOld = registerEditorCommands("t1", { toggleComment: vi.fn() });
  const offNew = registerEditorCommands("t1", { toggleComment: vi.fn() });
  offOld();
  expect(hasEditorCommand("t1", "toggleComment")).toBe(true);
  offNew();
  expect(hasEditorCommand("t1", "toggleComment")).toBe(false);
});
