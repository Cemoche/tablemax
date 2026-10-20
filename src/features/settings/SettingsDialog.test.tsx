import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { KEYMAP_ACTIONS, useAction } from "../../lib/keymap";
import { strings } from "../../lib/strings";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { SettingsDialog } from "./SettingsDialog";

vi.mock("../../lib/ipc");

const platform = vi.hoisted(() => ({ mac: false }));
vi.mock("../../lib/platform", async (orig) => ({
  ...(await orig<typeof import("../../lib/platform")>()),
  isMac: () => platform.mac,
}));

beforeEach(() => {
  vi.resetAllMocks();
  platform.mac = false;
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
  await userEvent.keyboard("{Enter}");
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, pageSize: 500 });
});

test("a number is saved on Enter or blur, not while typing", async () => {
  setup();
  const input = screen.getByLabelText(strings.settings.pageSize);
  await userEvent.clear(input);
  await userEvent.type(input, "6");
  await userEvent.type(input, "0");
  await userEvent.type(input, "0");
  expect(input).toHaveValue("600");
  expect(ipc.settingsSet).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(ipc.settingsSet).toHaveBeenCalledTimes(1);
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, pageSize: 600 });
  const size = screen.getByLabelText(strings.settings.fontSize);
  await userEvent.clear(size);
  await userEvent.type(size, "16");
  expect(ipc.settingsSet).toHaveBeenCalledTimes(1);
  await userEvent.tab();
  expect(ipc.settingsSet).toHaveBeenCalledTimes(2);
  expect(ipc.settingsSet).toHaveBeenLastCalledWith(expect.objectContaining({ editorFontSize: 16 }));
});

test("an invalid number keeps its draft and error on Enter and blur, and sends nothing", async () => {
  setup();
  const input = screen.getByLabelText(strings.settings.pageSize);
  await userEvent.clear(input);
  await userEvent.type(input, "6000");
  await userEvent.keyboard("{Enter}");
  await userEvent.tab();
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveValue("6000");
  expect(screen.getByText(strings.settings.range(50, 5000))).toBeInTheDocument();
  expect(ipc.settingsSet).not.toHaveBeenCalled();
});

test("Escape reverts a number draft without closing the dialog; without a draft it closes", async () => {
  const { onClose } = setup();
  const input = screen.getByLabelText(strings.settings.pageSize);
  await userEvent.clear(input);
  await userEvent.type(input, "77");
  await userEvent.keyboard("{Escape}");
  expect(input).toHaveValue(String(DEFAULT_SETTINGS.pageSize));
  expect(onClose).not.toHaveBeenCalled();
  expect(ipc.settingsSet).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalled();
});

test("the auto LIMIT checkbox is saved", async () => {
  setup();
  await userEvent.click(screen.getByRole("checkbox", { name: strings.settings.autoLimit }));
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, autoLimitDefault: true });
});

test("the system title bar checkbox is saved and says when it applies", async () => {
  setup();
  const box = screen.getByRole("checkbox", { name: strings.settings.systemTitleBar });
  expect(box).toHaveAccessibleDescription(strings.settings.systemTitleBarHint);
  await userEvent.click(box);
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, useSystemTitleBar: true });
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

/** The combination shown on the Keyboard row of `label`. */
const shortcutOf = (label: string) => screen.getByText(label).closest("li")?.querySelector("kbd")?.textContent;

test("lists every keymap action with the platform's modifier names", () => {
  setup();
  for (const a of KEYMAP_ACTIONS) expect(screen.getByText(a.label)).toBeInTheDocument();
  // jsdom is not macOS: Mod reads Ctrl.
  expect(shortcutOf(strings.keymap["editor.run"])).toBe("Ctrl+Enter");
  expect(shortcutOf(strings.keymap["editor.runAll"])).toBe("Ctrl+Shift+Enter");
  expect(shortcutOf(strings.keymap["settings.open"])).toBe("Ctrl+,");
  expect(shortcutOf(strings.keymap["query.new"])).toBe("Ctrl+T");
  expect(screen.getByRole("dialog").textContent).not.toMatch(/Mod/);
});

test("the keyboard list shows a custom combination, and the default for an invalid entry", () => {
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, keymap: { "grid.commit": "Mod+Shift+S", "query.new": "Mod-N" } },
  });
  setup();
  expect(shortcutOf(strings.keymap["grid.commit"])).toBe("Ctrl+Shift+S");
  expect(shortcutOf(strings.keymap["query.save"])).toBe("Ctrl+S");
  expect(shortcutOf(strings.keymap["query.new"])).toBe("Ctrl+T");
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

const changeButton = (label: string) => screen.getByRole("button", { name: strings.settings.changeShortcutFor(label) });
const queryReset = (label: string) => screen.queryByRole("button", { name: strings.settings.resetShortcutFor(label) });
const paletteLabel = strings.keymap["palette.all"];

test("recording a combination saves it and the label updates", async () => {
  setup();
  await userEvent.click(changeButton(paletteLabel));
  expect(screen.getByText(strings.settings.recording)).toBeInTheDocument();
  await userEvent.keyboard("{Control>}{Shift>}y{/Shift}{/Control}");
  expect(ipc.settingsSet).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, keymap: { "palette.all": "Mod+Shift+Y" } });
  expect(shortcutOf(paletteLabel)).toBe("Ctrl+Shift+Y");
  expect(screen.queryByText(strings.settings.recording)).toBeNull();
});

test("recording follows the layout's letter, and the physical key on a non-Latin layout", async () => {
  setup();
  const key = (init: KeyboardEventInit) =>
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  // AZERTY: the key at QWERTY's W types "z".
  await userEvent.click(changeButton(paletteLabel));
  await act(async () => key({ code: "KeyW", key: "Z", ctrlKey: true, shiftKey: true }));
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, keymap: { "palette.all": "Mod+Shift+Z" } });
  expect(shortcutOf(paletteLabel)).toBe("Ctrl+Shift+Z");
  // Russian: the key at QWERTY's J types "о" and records as J.
  await userEvent.click(changeButton(paletteLabel));
  await act(async () => key({ code: "KeyJ", key: "о", ctrlKey: true, shiftKey: true }));
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, keymap: { "palette.all": "Mod+Shift+J" } });
  // Digits by position (AZERTY types "è" there without Shift).
  await userEvent.click(changeButton(paletteLabel));
  await act(async () => key({ code: "Digit7", key: "è", ctrlKey: true, shiftKey: true }));
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, keymap: { "palette.all": "Mod+Shift+7" } });
});

test("a combination used by another action is refused with its label and saves nothing", async () => {
  setup();
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Control>}k{/Control}");
  expect(screen.getByText(strings.settings.shortcutConflict(strings.keymap["database.open"]))).toBeInTheDocument();
  expect(ipc.settingsSet).not.toHaveBeenCalled();
  expect(shortcutOf(paletteLabel)).toBe("Ctrl+P");
});

test("a combination the grammar rejects shows an inline error and saves nothing", async () => {
  setup();
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("k");
  expect(screen.getByText(strings.settings.shortcutInvalid)).toBeInTheDocument();
  expect(ipc.settingsSet).not.toHaveBeenCalled();
});

test("Escape cancels recording without closing the dialog", async () => {
  const { onClose } = setup();
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByText(strings.settings.recording)).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(ipc.settingsSet).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("modifier-only presses are ignored while recording", async () => {
  setup();
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Control>}{Shift>}{Alt>}");
  expect(screen.getByText(strings.settings.recording)).toBeInTheDocument();
  expect(screen.queryByText(strings.settings.shortcutInvalid)).toBeNull();
  expect(ipc.settingsSet).not.toHaveBeenCalled();
  await userEvent.keyboard("{/Alt}{/Shift}{/Control}");
});

test("Reset appears only for an overridden action and removes the override", async () => {
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, keymap: { "palette.all": "Mod+Shift+K", "grid.commit": "Mod+Shift+S" } },
    confirmed: DEFAULT_SETTINGS,
  });
  setup();
  expect(queryReset(strings.keymap["query.new"])).toBeNull();
  await userEvent.click(queryReset(paletteLabel) as HTMLElement);
  expect(ipc.settingsSet).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, keymap: { "grid.commit": "Mod+Shift+S" } });
  expect(shortcutOf(paletteLabel)).toBe("Ctrl+P");
});

test("Reset is refused when the default is now used by another action (rebind, take, reset)", async () => {
  const newQuery = strings.keymap["query.new"];
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "query.new": "Mod+N" } }, confirmed: DEFAULT_SETTINGS });
  setup();
  // Mod+T is free once New query moved to Mod+N: the palette takes it.
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Control>}t{/Control}");
  expect(ipc.settingsSet).toHaveBeenCalledTimes(1);
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, keymap: { "query.new": "Mod+N", "palette.all": "Mod+T" } });
  // Resetting New query would bring Mod+T back for two global actions.
  await userEvent.click(queryReset(newQuery) as HTMLElement);
  expect(screen.getByRole("alert")).toHaveTextContent(strings.settings.shortcutConflict(paletteLabel));
  expect(ipc.settingsSet).toHaveBeenCalledTimes(1);
  expect(shortcutOf(newQuery)).toBe("Ctrl+N");
  expect(shortcutOf(paletteLabel)).toBe("Ctrl+T");
});

test("Reset is refused when an alternate default is now used by another action", async () => {
  const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  onTestFinished(() => spy.mockRestore());
  const previous = strings.keymap["workspace.previous"];
  // 1. Previous connection rebound: Mod+Shift+[ and Mod+Shift+PageUp are free.
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, keymap: { "workspace.previous": "Alt+P" } },
    confirmed: DEFAULT_SETTINGS,
  });
  setup();
  // 2. The palette takes the alternate.
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Control>}{Shift>}[PageUp]{/Shift}{/Control}");
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({
    ...DEFAULT_SETTINGS,
    keymap: { "workspace.previous": "Alt+P", "palette.all": "Mod+Shift+PageUp" },
  });
  // 3. Resetting would bind Mod+Shift+PageUp twice: refused like any conflict.
  await userEvent.click(queryReset(previous) as HTMLElement);
  expect(screen.getByRole("alert")).toHaveTextContent(strings.settings.shortcutConflict(paletteLabel));
  expect(ipc.settingsSet).toHaveBeenCalledTimes(1);
  expect(shortcutOf(previous)).toBe("Alt+P");
});

test("Reset is refused when the default would conflict on the other platform", async () => {
  // On Linux Meta+T is free next to Mod+T, but on macOS Meta+T is Mod+T.
  const newQuery = strings.keymap["query.new"];
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, keymap: { "query.new": "Mod+N", "palette.all": "Meta+T" } },
    confirmed: DEFAULT_SETTINGS,
  });
  setup();
  await userEvent.click(queryReset(newQuery) as HTMLElement);
  expect(screen.getByRole("alert")).toHaveTextContent(strings.settings.shortcutConflict(paletteLabel));
  expect(ipc.settingsSet).not.toHaveBeenCalled();
});

test("a combination that conflicts on the other platform is refused (Meta+T is Mod+T on macOS)", async () => {
  setup();
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Meta>}t{/Meta}");
  expect(screen.getByText(strings.settings.shortcutConflict(strings.keymap["query.new"]))).toBeInTheDocument();
  expect(ipc.settingsSet).not.toHaveBeenCalled();
});

test("Shift alone is not a modifier: Shift+K is refused as invalid", async () => {
  setup();
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Shift>}k{/Shift}");
  expect(screen.getByText(strings.settings.shortcutInvalid)).toBeInTheDocument();
  expect(ipc.settingsSet).not.toHaveBeenCalled();
});

test("recording the default combination removes the override instead of storing it", async () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "palette.all": "Mod+Shift+K" } }, confirmed: DEFAULT_SETTINGS });
  setup();
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Control>}p{/Control}");
  expect(ipc.settingsSet).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, keymap: {} });
});

test("Tab without modifiers cancels recording; Ctrl+Tab style combinations are candidates", async () => {
  setup();
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Tab}");
  expect(screen.queryByText(strings.settings.recording)).toBeNull();
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Alt>}{Tab}{/Alt}");
  expect(ipc.settingsSet).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, keymap: { "palette.all": "Alt+Tab" } });
});

test("recording the default combination in another spelling stores no override (Ctrl+Tab for tab.next)", async () => {
  setup();
  const label = strings.keymap["tab.next"];
  await userEvent.click(changeButton(label));
  await userEvent.keyboard("{Control>}{Tab}{/Control}");
  expect(queryReset(label)).toBeNull();
  expect(ipc.settingsSet).not.toHaveBeenCalled();
});

test("an override spelled differently from the default is removed when its default is recorded", async () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "tab.next": "Mod+Tab" } }, confirmed: DEFAULT_SETTINGS });
  setup();
  expect(queryReset(strings.keymap["tab.next"])).toBeNull();
});

test("on macOS Meta records as Mod and Ctrl stays Ctrl", async () => {
  platform.mac = true;
  setup();
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Meta>}{Shift>}y{/Shift}{/Meta}");
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, keymap: { "palette.all": "Mod+Shift+Y" } });
  await userEvent.click(changeButton(strings.keymap["tab.close"]));
  await userEvent.keyboard("{Control>}j{/Control}");
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({
    ...DEFAULT_SETTINGS,
    keymap: { "palette.all": "Mod+Shift+Y", "tab.close": "Ctrl+J" },
  });
});

function Probe({ onFire }: { onFire: () => void }) {
  useAction("query.new", onFire, { allowInModal: true });
  return null;
}

test("a global shortcut does not fire while recording, and fires again after cancel and after unmount", async () => {
  const onFire = vi.fn();
  const onClose = vi.fn();
  const { rerender } = render(
    <>
      <Probe onFire={onFire} />
      <SettingsDialog onClose={onClose} />
    </>,
  );
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Control>}t{/Control}"); // query.new's own combination, recorded for palette.all
  expect(onFire).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  await userEvent.keyboard("{Control>}t{/Control}");
  expect(onFire).toHaveBeenCalledTimes(1);
  await userEvent.click(changeButton(paletteLabel));
  rerender(<Probe onFire={onFire} />);
  await userEvent.keyboard("{Control>}t{/Control}");
  expect(onFire).toHaveBeenCalledTimes(2);
});

test("closing the dialog gives the focus back to the element that opened it", async () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const { unmount } = render(<SettingsDialog onClose={vi.fn()} />);
  expect(opener).not.toHaveFocus();
  unmount();
  expect(opener).toHaveFocus();
  opener.remove();
});
