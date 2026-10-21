import { act, render, screen, within } from "@testing-library/react";
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

const SEC = strings.settings.sections;
/** Shows the section `name` (a tab of the dialog's section list). */
const openSection = (name: string) => userEvent.click(screen.getByRole("tab", { name }));
const setupKeymap = async () => {
  const r = setup();
  await openSection(SEC.keymap);
  return r;
};

test("settings_sections_and_fields: General, Table, Editor, Fonts & Themes and Keymap, each with its labelled fields", async () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, interfaceScale: 1.15, dataFontSize: 14, editorFontSize: 15 } });
  setup();
  const list = screen.getByRole("tablist", { name: strings.settings.sectionsLabel });
  expect(list).toHaveAttribute("aria-orientation", "vertical");
  const tabs = within(list).getAllByRole("tab");
  expect(tabs.map((t) => t.textContent)).toEqual([SEC.general, SEC.table, SEC.editor, SEC.fonts, SEC.keymap]);
  // General is shown first; one Tab stop for the list (the selected section).
  expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1]);
  const panel = () => screen.getByRole("tabpanel");
  expect(panel()).toHaveAccessibleName(SEC.general);
  expect(tabs[0]).toHaveAttribute("aria-controls", panel().id);
  expect(within(panel()).getByRole("checkbox", { name: strings.settings.systemTitleBar })).toBeInTheDocument();
  expect(within(panel()).getByText(strings.settings.license)).toBeInTheDocument();

  await openSection(SEC.table);
  expect(panel()).toHaveAccessibleName(SEC.table);
  expect(within(panel()).getByLabelText(strings.settings.pageSize)).toHaveValue(String(DEFAULT_SETTINGS.pageSize));
  expect(within(panel()).getByLabelText(strings.settings.exactCount)).toBeInTheDocument();
  // Every section stays mounted (drafts survive a switch); the others are hidden, each
  // tab controlling its own panel.
  const panels = document.querySelectorAll('[role="tabpanel"]');
  expect(panels).toHaveLength(5);
  expect([...panels].filter((p) => !(p as HTMLElement).hidden)).toEqual([panel()]);
  for (const t of tabs) {
    const own = document.getElementById(t.getAttribute("aria-controls") ?? "");
    expect(own).toHaveAttribute("role", "tabpanel");
    expect(own).toHaveAttribute("aria-labelledby", t.id);
  }
  expect(screen.queryByRole("checkbox", { name: strings.settings.systemTitleBar })).toBeNull();
  expect(
    screen.getByRole("checkbox", { name: strings.settings.systemTitleBar, hidden: true }).closest("[hidden]"),
  ).not.toBeNull();

  await openSection(SEC.editor);
  expect(within(panel()).getByRole("checkbox", { name: strings.settings.autoLimit })).toBeInTheDocument();
  expect(within(panel()).getByLabelText(strings.settings.autoLimitValue)).toBeInTheDocument();

  await openSection(SEC.fonts);
  const theme = within(panel()).getByRole("radiogroup", { name: strings.settings.theme });
  expect(within(theme).getAllByRole("radio").map((r) => r.getAttribute("value"))).toEqual(["system", "light", "dark"]);
  expect(within(theme).getByRole("radio", { name: strings.settings.themeSystem })).toBeChecked();
  expect(within(panel()).getByRole("combobox", { name: strings.settings.interfaceSize })).toHaveValue("1.15");
  expect(within(panel()).getByLabelText(strings.settings.dataFontSize)).toHaveValue("14");
  expect(within(panel()).getByLabelText(strings.settings.editorFontSize)).toHaveValue("15");
  expect(within(panel()).getByLabelText(strings.settings.fontFamily)).toBeInTheDocument();
  // The font size keys are named next to the sizes (Ctrl+= / Ctrl+-).
  expect(panel()).toHaveTextContent(strings.settings.fontSizeKeysHint("Ctrl+=", "Ctrl+-"));

  await openSection(SEC.keymap);
  // Grouped by where the shortcut acts; each action in its scope's group.
  const group = (scope: keyof typeof strings.settings.scopes) =>
    within(panel()).getByRole("group", { name: strings.settings.scopes[scope] });
  expect(within(group("global")).getByText(strings.keymap["palette.all"])).toBeInTheDocument();
  expect(within(group("tableTab")).getByText(strings.keymap["grid.commit"])).toBeInTheDocument();
  expect(within(group("filterBar")).getByText(strings.keymap["filters.toggle"])).toBeInTheDocument();
  expect(within(group("queryTab")).getByText(strings.keymap["query.save"])).toBeInTheDocument();
  expect(within(group("editor")).getByText(strings.keymap["editor.run"])).toBeInTheDocument();
  expect(within(group("connectionList")).getByText(strings.keymap["connections.search"])).toBeInTheDocument();
  expect(within(group("global")).queryByText(strings.keymap["editor.run"])).toBeNull();
});

test("an invalid draft and its error survive a section switch", async () => {
  setup();
  await openSection(SEC.table);
  const input = screen.getByLabelText(strings.settings.pageSize);
  await userEvent.clear(input);
  await userEvent.type(input, "6000");
  await openSection(SEC.fonts);
  await openSection(SEC.table);
  expect(screen.getByLabelText(strings.settings.pageSize)).toHaveValue("6000");
  expect(screen.getByLabelText(strings.settings.pageSize)).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByText(strings.settings.range(50, 5000))).toBeVisible();
  expect(ipc.settingsSet).not.toHaveBeenCalled();
});

test("Tab never lands in a hidden section", async () => {
  setup();
  const dialog = screen.getByRole("dialog");
  for (let i = 0; i < 30; i++) {
    await userEvent.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect((document.activeElement as HTMLElement).closest("[hidden]")).toBeNull();
  }
  for (let i = 0; i < 10; i++) {
    await userEvent.tab({ shift: true });
    expect((document.activeElement as HTMLElement).closest("[hidden]")).toBeNull();
  }
});

test("the section list moves with the arrow keys, Home and End", async () => {
  setup();
  const tab = (name: string) => screen.getByRole("tab", { name });
  tab(SEC.general).focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(tab(SEC.table)).toHaveFocus();
  expect(tab(SEC.table)).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tabpanel")).toHaveAccessibleName(SEC.table);
  await userEvent.keyboard("{End}");
  expect(tab(SEC.keymap)).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  expect(tab(SEC.general)).toHaveFocus();
  await userEvent.keyboard("{ArrowUp}");
  expect(tab(SEC.keymap)).toHaveFocus();
  await userEvent.keyboard("{Home}");
  expect(tab(SEC.general)).toHaveFocus();
  expect(tab(SEC.general)).toHaveAttribute("aria-selected", "true");
});

test("interface_size_control_updates_zoom: choosing a size zooms the window at once and saves it", async () => {
  setup();
  await openSection(SEC.fonts);
  const size = screen.getByRole("combobox", { name: strings.settings.interfaceSize });
  expect(size).toHaveValue("1");
  const options = within(size).getAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual(["90%", "95%", "100%", "105%", "110%", "115%", "120%", "125%", "130%"]);
  await userEvent.selectOptions(size, "1.3");
  expect(ipc.windowSetZoom).toHaveBeenLastCalledWith(1.3);
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, interfaceScale: 1.3 });
  expect(size).toHaveValue("1.3");
  await userEvent.selectOptions(size, "0.95");
  expect(ipc.windowSetZoom).toHaveBeenLastCalledWith(0.95);
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, interfaceScale: 0.95 });
});

test("a stored scale off the 5 % grid shows its nearest step", async () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, interfaceScale: 1.2999999523162842 } });
  setup();
  await openSection(SEC.fonts);
  expect(screen.getByRole("combobox", { name: strings.settings.interfaceSize })).toHaveValue("1.3");
});

test("the data font size is saved like the editor's", async () => {
  setup();
  await openSection(SEC.fonts);
  const input = screen.getByLabelText(strings.settings.dataFontSize);
  await userEvent.clear(input);
  await userEvent.type(input, "16{Enter}");
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, dataFontSize: 16 });
});

test("is a modal dialog labelled by its title with focus inside", async () => {
  setup();
  const dialog = screen.getByRole("dialog", { name: strings.settings.title });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
  await screen.findByText(/1\.2\.3/);
});

test("changing the theme saves it and sets data-theme at once", async () => {
  setup();
  await openSection(SEC.fonts);
  await userEvent.click(screen.getByRole("radio", { name: strings.settings.themeDark }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(ipc.settingsSet).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, theme: "dark" });
});

test("an out-of-range page size shows an error and sends nothing", async () => {
  setup();
  await openSection(SEC.table);
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
  await openSection(SEC.fonts);
  const input = screen.getByLabelText(strings.settings.editorFontSize);
  await userEvent.clear(input);
  await userEvent.type(input, "1.5");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(ipc.settingsSet).not.toHaveBeenCalled();
});

test("a valid number is saved and clears the error", async () => {
  setup();
  await openSection(SEC.table);
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
  await openSection(SEC.table);
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
  await openSection(SEC.fonts);
  const size = screen.getByLabelText(strings.settings.editorFontSize);
  await userEvent.clear(size);
  await userEvent.type(size, "16");
  expect(ipc.settingsSet).toHaveBeenCalledTimes(1);
  await userEvent.tab();
  expect(ipc.settingsSet).toHaveBeenCalledTimes(2);
  expect(ipc.settingsSet).toHaveBeenLastCalledWith(expect.objectContaining({ editorFontSize: 16 }));
});

test("an invalid number keeps its draft and error on Enter and blur, and sends nothing", async () => {
  setup();
  await openSection(SEC.table);
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
  await openSection(SEC.table);
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
  await openSection(SEC.editor);
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
  await openSection(SEC.fonts);
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
    await openSection(SEC.fonts);
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
  await openSection(SEC.fonts);
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

test("lists every keymap action with the platform's modifier names", async () => {
  setup();
  await openSection(SEC.keymap);
  for (const a of KEYMAP_ACTIONS) expect(screen.getByText(a.label)).toBeInTheDocument();
  // jsdom is not macOS: Mod reads Ctrl.
  expect(shortcutOf(strings.keymap["editor.run"])).toBe("Ctrl+Enter");
  expect(shortcutOf(strings.keymap["editor.runAll"])).toBe("Ctrl+Shift+Enter");
  expect(shortcutOf(strings.keymap["settings.open"])).toBe("Ctrl+,");
  expect(shortcutOf(strings.keymap["query.new"])).toBe("Ctrl+T");
  expect(screen.getByRole("dialog").textContent).not.toMatch(/Mod/);
});

test("the keyboard list shows a custom combination, and the default for an invalid entry", async () => {
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, keymap: { "grid.commit": "Mod+Shift+S", "query.new": "Mod-N" } },
  });
  setup();
  await openSection(SEC.keymap);
  expect(shortcutOf(strings.keymap["grid.commit"])).toBe("Ctrl+Shift+S");
  expect(shortcutOf(strings.keymap["query.save"])).toBe("Ctrl+S");
  expect(shortcutOf(strings.keymap["query.new"])).toBe("Ctrl+T");
});

/** Every combination a row shows (its default and alternates, or the custom one). */
const shortcutsOf = (label: string) =>
  [...(screen.getByText(label).closest("li")?.querySelectorAll("kbd") ?? [])].map((k) => k.textContent);

test("shortcut_alternates_listed: a row shows every default combination; a custom one replaces them (#90)", async () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "tab.previous": "Alt+P" } } });
  setup();
  await openSection(SEC.keymap);
  expect(shortcutsOf(strings.keymap["tab.next"])).toEqual(["Ctrl+Tab", "Ctrl+]", "Ctrl+PageDown"]);
  expect(shortcutsOf(strings.keymap["editor.format"])).toEqual(["Ctrl+I", "Ctrl+Shift+F"]);
  expect(shortcutsOf(strings.keymap["font.increase"])).toEqual(["Ctrl+=", "Ctrl+Shift+=", "Ctrl+Num +"]);
  expect(shortcutsOf(strings.keymap["tab.previous"])).toEqual(["Alt+P"]);
  // The labels name no key of their own: the list shows the keys (#90).
  for (const a of KEYMAP_ACTIONS) expect(a.label, a.id).not.toMatch(/Ctrl\+|⌘/);
});

test("saved_binding_collision_flagged: a custom binding equal to another action's new default is flagged, not rewritten", async () => {
  // Saved before #90, when Ctrl+Shift+P was free: it is now Preview's default (table tabs).
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, keymap: { "grid.copyCells": "Mod+Shift+P" } },
    confirmed: DEFAULT_SETTINGS,
  });
  setup();
  await openSection(SEC.keymap);
  const row = screen.getByText(strings.keymap["grid.copyCells"]).closest("li") as HTMLElement;
  expect(row).toHaveTextContent(strings.settings.shortcutCollision(strings.keymap["grid.preview"]));
  expect(shortcutOf(strings.keymap["grid.copyCells"])).toBe("Ctrl+Shift+P");
  // A row without a collision says nothing; nothing is saved by just showing the list.
  const commit = screen.getByText(strings.keymap["grid.commit"]).closest("li") as HTMLElement;
  expect(commit.querySelector('[role="status"]')).toBeNull();
  expect(ipc.settingsSet).not.toHaveBeenCalled();
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
  await setupKeymap();
  await userEvent.click(changeButton(paletteLabel));
  expect(screen.getByText(strings.settings.recording)).toBeInTheDocument();
  await userEvent.keyboard("{Control>}{Shift>}y{/Shift}{/Control}");
  expect(ipc.settingsSet).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, keymap: { "palette.all": "Mod+Shift+Y" } });
  expect(shortcutOf(paletteLabel)).toBe("Ctrl+Shift+Y");
  expect(screen.queryByText(strings.settings.recording)).toBeNull();
});

test("recording follows the layout's letter, and the physical key on a non-Latin layout", async () => {
  await setupKeymap();
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

test("recording names punctuation as the layout types it, Shift included in the character (#105)", async () => {
  await setupKeymap();
  const key = (init: KeyboardEventInit) =>
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  // Dvorak: the key at QWERTY's Z types ";".
  await userEvent.click(changeButton(paletteLabel));
  await act(async () => key({ code: "KeyZ", key: ";", ctrlKey: true }));
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, keymap: { "palette.all": "Mod+;" } });
  expect(shortcutOf(paletteLabel)).toBe("Ctrl+;");
  // QWERTZ: Ctrl+Shift+7 types "/": that is Ctrl+/, the comment's key, refused.
  await userEvent.click(changeButton(paletteLabel));
  await act(async () => key({ code: "Digit7", key: "/", ctrlKey: true, shiftKey: true }));
  expect(screen.getByText(strings.settings.shortcutConflict(strings.keymap["editor.comment"]))).toBeInTheDocument();
});

test("recording on a non-Latin layout names punctuation by US position, after a letter typed (#131)", async () => {
  await setupKeymap();
  const key = (init: KeyboardEventInit) =>
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  // Russian: a letter typed ("а", refused: no modifier), then Ctrl + the "/" keycap (it types
  // "."): Ctrl+/, the comment's key, refused.
  await userEvent.click(changeButton(paletteLabel));
  await act(async () => key({ code: "KeyF", key: "а" }));
  await act(async () => key({ code: "Slash", key: ".", ctrlKey: true }));
  expect(screen.getByText(strings.settings.shortcutConflict(strings.keymap["editor.comment"]))).toBeInTheDocument();
  expect(ipc.settingsSet).not.toHaveBeenCalled();
  // Hebrew: Ctrl + the Q keycap (it types "/") is Ctrl+Q.
  await act(async () => key({ code: "KeyA", key: "ש" }));
  await act(async () => key({ code: "KeyQ", key: "/", ctrlKey: true }));
  expect(ipc.settingsSet).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, keymap: { "palette.all": "Mod+Q" } });
});

test("a combination used by another action is refused with its label and saves nothing", async () => {
  await setupKeymap();
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Control>}k{/Control}");
  expect(screen.getByText(strings.settings.shortcutConflict(strings.keymap["database.open"]))).toBeInTheDocument();
  expect(ipc.settingsSet).not.toHaveBeenCalled();
  expect(shortcutOf(paletteLabel)).toBe("Ctrl+P");
});

test("a combination the grammar rejects shows an inline error and saves nothing", async () => {
  await setupKeymap();
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("k");
  expect(screen.getByText(strings.settings.shortcutInvalid)).toBeInTheDocument();
  expect(ipc.settingsSet).not.toHaveBeenCalled();
});

test("Escape cancels recording without closing the dialog", async () => {
  const { onClose } = await setupKeymap();
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByText(strings.settings.recording)).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(ipc.settingsSet).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("modifier-only presses are ignored while recording", async () => {
  await setupKeymap();
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
  await setupKeymap();
  expect(queryReset(strings.keymap["query.new"])).toBeNull();
  await userEvent.click(queryReset(paletteLabel) as HTMLElement);
  expect(ipc.settingsSet).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, keymap: { "grid.commit": "Mod+Shift+S" } });
  expect(shortcutOf(paletteLabel)).toBe("Ctrl+P");
});

test("Reset is refused when the default is now used by another action (rebind, take, reset)", async () => {
  const newQuery = strings.keymap["query.new"];
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "query.new": "Mod+N" } }, confirmed: DEFAULT_SETTINGS });
  await setupKeymap();
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
  await setupKeymap();
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
  await setupKeymap();
  await userEvent.click(queryReset(newQuery) as HTMLElement);
  expect(screen.getByRole("alert")).toHaveTextContent(strings.settings.shortcutConflict(paletteLabel));
  expect(ipc.settingsSet).not.toHaveBeenCalled();
});

test("a combination that conflicts on the other platform is refused (Meta+T is Mod+T on macOS)", async () => {
  await setupKeymap();
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Meta>}t{/Meta}");
  expect(screen.getByText(strings.settings.shortcutConflict(strings.keymap["query.new"]))).toBeInTheDocument();
  expect(ipc.settingsSet).not.toHaveBeenCalled();
});

test("Shift alone is not a modifier: Shift+K is refused as invalid", async () => {
  await setupKeymap();
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Shift>}k{/Shift}");
  expect(screen.getByText(strings.settings.shortcutInvalid)).toBeInTheDocument();
  expect(ipc.settingsSet).not.toHaveBeenCalled();
});

test("recording the default combination removes the override instead of storing it", async () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "palette.all": "Mod+Shift+K" } }, confirmed: DEFAULT_SETTINGS });
  await setupKeymap();
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Control>}p{/Control}");
  expect(ipc.settingsSet).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, keymap: {} });
});

test("Tab without modifiers cancels recording; Ctrl+Tab style combinations are candidates", async () => {
  await setupKeymap();
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Tab}");
  expect(screen.queryByText(strings.settings.recording)).toBeNull();
  await userEvent.click(changeButton(paletteLabel));
  await userEvent.keyboard("{Alt>}{Tab}{/Alt}");
  expect(ipc.settingsSet).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, keymap: { "palette.all": "Alt+Tab" } });
});

test("recording the default combination in another spelling stores no override (Ctrl+Tab for tab.next)", async () => {
  await setupKeymap();
  const label = strings.keymap["tab.next"];
  await userEvent.click(changeButton(label));
  await userEvent.keyboard("{Control>}{Tab}{/Control}");
  expect(queryReset(label)).toBeNull();
  expect(ipc.settingsSet).not.toHaveBeenCalled();
});

test("an override spelled differently from the default is removed when its default is recorded", async () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "tab.next": "Mod+Tab" } }, confirmed: DEFAULT_SETTINGS });
  await setupKeymap();
  expect(queryReset(strings.keymap["tab.next"])).toBeNull();
});

test("on macOS Meta records as Mod and Ctrl stays Ctrl", async () => {
  platform.mac = true;
  await setupKeymap();
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
  await openSection(SEC.keymap);
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
