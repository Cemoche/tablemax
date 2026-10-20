import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { strings } from "../../lib/strings";
import { PagePopover } from "./PagePopover";
import { LIMIT_MAX } from "./usePagedTable";

const p = strings.grid.pagePopover;
let onGo: ReturnType<typeof vi.fn<(offset: number, limit: number) => boolean>>;
let onClose: ReturnType<typeof vi.fn<(refocus: boolean) => void>>;

beforeEach(() => {
  onGo = vi.fn<(offset: number, limit: number) => boolean>(() => true);
  onClose = vi.fn<(refocus: boolean) => void>();
});

const setup = () => render(<PagePopover offset={300} limit={300} onGo={onGo} onClose={onClose} />);
const offset = () => screen.getByRole("textbox", { name: p.offset });
const limit = () => screen.getByRole("textbox", { name: p.limit });

test("page_popover_offset_limit: shows the current offset and limit; Go applies the typed ones and closes", async () => {
  setup();
  expect(screen.getByRole("dialog", { name: p.label })).toBeInTheDocument();
  expect(offset()).toHaveValue("300");
  expect(limit()).toHaveValue("300");
  // The offset has the focus, its text selected: typing replaces it.
  expect(offset()).toHaveFocus();
  await userEvent.keyboard("1,250");
  await userEvent.clear(limit());
  await userEvent.type(limit(), "50");
  await userEvent.click(screen.getByRole("button", { name: p.go }));
  expect(onGo).toHaveBeenCalledWith(1250, 50);
  expect(onClose).toHaveBeenCalledWith(true);
});

test("Enter in a field is Go; bad numbers say why and change nothing", async () => {
  setup();
  await userEvent.clear(offset());
  await userEvent.type(offset(), "-3{Enter}");
  expect(screen.getByRole("alert")).toHaveTextContent(p.offsetInvalid);
  expect(onGo).not.toHaveBeenCalled();
  expect(offset()).toHaveAttribute("aria-invalid", "true");
  await userEvent.clear(offset());
  await userEvent.type(offset(), "0");
  await userEvent.clear(limit());
  await userEvent.type(limit(), `${LIMIT_MAX + 1}{Enter}`);
  expect(screen.getByRole("alert")).toHaveTextContent(p.limitInvalid(1, LIMIT_MAX));
  await userEvent.clear(limit());
  await userEvent.type(limit(), "abc{Enter}");
  expect(onGo).not.toHaveBeenCalled();
  await userEvent.clear(limit());
  await userEvent.type(limit(), "10{Enter}");
  expect(onGo).toHaveBeenCalledWith(0, 10);
});

test("a refused Go (changes pending) keeps the popover open", async () => {
  onGo.mockReturnValue(false);
  setup();
  await userEvent.click(screen.getByRole("button", { name: p.go }));
  expect(onGo).toHaveBeenCalledWith(300, 300);
  expect(onClose).not.toHaveBeenCalled();
});

test("Escape closes it and asks for the focus back; a press outside closes it without", async () => {
  setup();
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenLastCalledWith(true);
  await userEvent.click(document.body);
  expect(onClose).toHaveBeenLastCalledWith(false);
});
