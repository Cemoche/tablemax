import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { SettingsDialog } from "./SettingsDialog";

vi.mock("../../lib/ipc");

beforeEach(() => {
  vi.resetAllMocks();
  delete document.documentElement.dataset.theme;
  useSettings.setState({ settings: DEFAULT_SETTINGS, confirmed: DEFAULT_SETTINGS, loaded: true, error: null });
  vi.mocked(ipc.settingsSet).mockImplementation(async (s) => s);
  vi.mocked(ipc.appVersion).mockResolvedValue("1.2.3");
});

const setup = () => {
  const onClose = vi.fn();
  render(<SettingsDialog onClose={onClose} />);
  return { onClose };
};

test("is a modal dialog labelled by its title with focus inside", async () => {
  setup();
  const dialog = screen.getByRole("dialog", { name: strings.settings.title });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
  await screen.findByText(/1\.2\.3/);
});

test("changing the theme saves it and sets data-theme at once", async () => {
  setup();
  await userEvent.click(screen.getByRole("radio", { name: strings.settings.themeDark }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(ipc.settingsSet).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, theme: "dark" });
});

test("an out-of-range page size shows an error and sends nothing", async () => {
  setup();
  const input = screen.getByLabelText(strings.settings.pageSize);
  await userEvent.clear(input);
  await userEvent.click(input);
  await userEvent.paste("6000");
  expect(input).toHaveAttribute("aria-invalid", "true");
  const msg = document.getElementById(input.getAttribute("aria-describedby") ?? "");
  expect(msg).toHaveTextContent(strings.settings.range(50, 5000));
  expect(ipc.settingsSet).not.toHaveBeenCalled();
});

test("a non-integer value is rejected", async () => {
  setup();
  const input = screen.getByLabelText(strings.settings.fontSize);
  await userEvent.clear(input);
  await userEvent.type(input, "1.5");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(ipc.settingsSet).not.toHaveBeenCalled();
});

test("a valid number is saved and clears the error", async () => {
  setup();
  const input = screen.getByLabelText(strings.settings.pageSize);
  await userEvent.clear(input);
  await userEvent.paste("6000");
  expect(input).toHaveAttribute("aria-invalid", "true");
  await userEvent.clear(input);
  await userEvent.paste("500");
  expect(input).not.toHaveAttribute("aria-invalid", "true");
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, pageSize: 500 });
});

test("the auto LIMIT checkbox is saved", async () => {
  setup();
  await userEvent.click(screen.getByRole("checkbox", { name: strings.settings.autoLimit }));
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, autoLimitDefault: true });
});

test("the font family is saved on Enter or blur, not on each keystroke", async () => {
  setup();
  const input = screen.getByLabelText(strings.settings.fontFamily);
  await userEvent.type(input, "JetBrains Mono, monospace");
  expect(ipc.settingsSet).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(ipc.settingsSet).toHaveBeenCalledTimes(1);
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({
    ...DEFAULT_SETTINGS,
    editorFontFamily: "JetBrains Mono, monospace",
  });
  await userEvent.clear(input);
  await userEvent.type(input, '"Fira Code", monospace');
  expect(ipc.settingsSet).toHaveBeenCalledTimes(1);
  await userEvent.tab();
  expect(ipc.settingsSet).toHaveBeenCalledTimes(2);
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({
    ...DEFAULT_SETTINGS,
    editorFontFamily: '"Fira Code", monospace',
  });
});

test.each(["x; } .a { color: red", "url(x)", "a:b", '"Fira'])(
  "an invalid font family %s shows an error and is never sent",
  async (bad) => {
    setup();
    const input = screen.getByLabelText(strings.settings.fontFamily);
    await userEvent.click(input);
    await userEvent.paste(bad);
    expect(input).toHaveAttribute("aria-invalid", "true");
    const msg = document.getElementById(input.getAttribute("aria-describedby") ?? "");
    expect(msg).toHaveTextContent(strings.settings.fontFamilyInvalid);
    await userEvent.keyboard("{Enter}");
    await userEvent.tab();
    expect(ipc.settingsSet).not.toHaveBeenCalled();
    // The text stays so it can be fixed.
    expect(input).toHaveValue(bad);
  },
);

test("clearing the font family saves the default", async () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, editorFontFamily: "Fira Code" } });
  setup();
  const input = screen.getByLabelText(strings.settings.fontFamily);
  await userEvent.clear(input);
  await userEvent.tab();
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, editorFontFamily: "" });
});

test("About shows the version, the license line and the repository as text", async () => {
  setup();
  expect(await screen.findByText(/1\.2\.3/)).toBeInTheDocument();
  expect(screen.getByText(strings.settings.license)).toBeInTheDocument();
  expect(screen.getByText(new RegExp(strings.settings.repositoryUrl))).toBeInTheDocument();
  expect(screen.queryByRole("link")).toBeNull();
});

test("lists the keyboard shortcuts", () => {
  setup();
  expect(screen.getByText(strings.settings.shortcutRun)).toBeInTheDocument();
  expect(screen.getByText(strings.settings.shortcutSettings)).toBeInTheDocument();
});

test("Escape closes, even when focus is outside the dialog", async () => {
  const { onClose } = setup();
  (document.activeElement as HTMLElement).blur();
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("the Close button closes", async () => {
  const { onClose } = setup();
  await userEvent.click(screen.getByRole("button", { name: strings.settings.close }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("Tab cycles inside the dialog", async () => {
  setup();
  const dialog = screen.getByRole("dialog");
  for (let i = 0; i < 40; i++) {
    await userEvent.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  }
});
