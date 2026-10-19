import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import { ConfirmRunDialog } from "./features/safety/ConfirmRunDialog";
import * as ipc from "./lib/ipc";
import { strings } from "./lib/strings";

vi.mock("./lib/ipc");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ipc.connectionsList).mockResolvedValue([]);
  vi.mocked(ipc.appVersion).mockResolvedValue("1.2.3");
});
afterEach(() => {
  vi.restoreAllMocks();
});

const platform = (p: string) => vi.spyOn(navigator, "platform", "get").mockReturnValue(p);
const settingsDialog = () => screen.queryByRole("dialog", { name: strings.settings.title });

test("the gear button opens the settings dialog", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: strings.settings.open }));
  expect(screen.getByRole("dialog", { name: strings.settings.title })).toBeInTheDocument();
});

test("Ctrl+, opens the settings dialog and Escape closes it", async () => {
  render(<App />);
  await userEvent.keyboard("{Control>}[Comma]{/Control}");
  expect(screen.getByRole("dialog", { name: strings.settings.title })).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Mod+, is Ctrl+, on Linux: Meta+, does not open the settings", async () => {
  platform("Linux x86_64");
  render(<App />);
  await userEvent.keyboard("{Meta>}[Comma]{/Meta}");
  expect(settingsDialog()).toBeNull();
  await userEvent.keyboard("{Control>}[Comma]{/Control}");
  expect(settingsDialog()).toBeInTheDocument();
});

test("Mod+, is Cmd+, on macOS: Ctrl+, does not open the settings", async () => {
  platform("MacIntel");
  render(<App />);
  await userEvent.keyboard("{Control>}[Comma]{/Control}");
  expect(settingsDialog()).toBeNull();
  await userEvent.keyboard("{Meta>}[Comma]{/Meta}");
  expect(settingsDialog()).toBeInTheDocument();
});

test("Mod+, does nothing while another modal (the run confirmation) is open", async () => {
  platform("Linux x86_64");
  render(
    <>
      <App />
      <ConfirmRunDialog
        connectionName="prod"
        envTag="prod"
        statements={["delete from t"]}
        flagged={[0]}
        onRun={() => {}}
        onCancel={() => {}}
      />
    </>,
  );
  // Both the character and the physical key of Ctrl+,.
  window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", code: "Comma", ctrlKey: true, cancelable: true }));
  await userEvent.keyboard("{Control>}[Comma]{/Control}");
  expect(settingsDialog()).toBeNull();
});
