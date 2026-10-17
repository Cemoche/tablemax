import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import * as ipc from "./lib/ipc";
import { strings } from "./lib/strings";

vi.mock("./lib/ipc");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ipc.connectionsList).mockResolvedValue([]);
  vi.mocked(ipc.appVersion).mockResolvedValue("1.2.3");
});

test("the gear button opens the settings dialog", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: strings.settings.open }));
  expect(screen.getByRole("dialog", { name: strings.settings.title })).toBeInTheDocument();
});

test("Ctrl+, opens the settings dialog and Escape closes it", async () => {
  render(<App />);
  await userEvent.keyboard("{Control>},{/Control}");
  expect(screen.getByRole("dialog", { name: strings.settings.title })).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
});
