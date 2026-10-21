import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import { TIP_ATTR } from "../../lib/tooltip";
import { WelcomePane } from "./WelcomePane";

vi.mock("../../lib/ipc");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ipc.appVersion).mockResolvedValue("1.2.3");
});

test("welcome_pane_actions: our mark, name and version, then its three actions", async () => {
  const user = userEvent.setup();
  const onCreate = vi.fn();
  const onImport = vi.fn();
  const onOpenSqlite = vi.fn();
  render(<WelcomePane onCreate={onCreate} onImport={onImport} onOpenSqlite={onOpenSqlite} />);
  const pane = screen.getByRole("region", { name: strings.connections.welcomeLabel });
  // The app's own icon (assets/icon/tablemax.svg), decorative next to the name.
  expect(pane.querySelector("img")).toHaveAttribute("alt", "");
  expect(within(pane).getByRole("heading", { name: strings.appName })).toBeInTheDocument();
  expect(await within(pane).findByText(strings.connections.version("1.2.3"))).toBeInTheDocument();
  // Spec §2.4's three actions, in its order (Open SQLite file…: #117).
  expect(within(pane).getAllByRole("button").map((b) => b.textContent)).toEqual([
    strings.connections.create,
    strings.connections.importConnections,
    strings.connections.openSqlite,
  ]);
  await user.click(within(pane).getByRole("button", { name: strings.connections.create }));
  expect(onCreate).toHaveBeenCalled();
  await user.click(within(pane).getByRole("button", { name: strings.connections.importConnections }));
  expect(onImport).toHaveBeenCalled();
  const openSqlite = within(pane).getByRole("button", { name: strings.connections.openSqlite });
  expect(openSqlite).toHaveAttribute(TIP_ATTR, strings.connections.openSqliteHint);
  expect(onOpenSqlite).not.toHaveBeenCalled();
  await user.click(openSqlite);
  expect(onOpenSqlite).toHaveBeenCalledTimes(1);
});

test("a failed version lookup just leaves the version out", async () => {
  vi.mocked(ipc.appVersion).mockRejectedValue(new Error("no"));
  render(<WelcomePane onCreate={vi.fn()} onImport={vi.fn()} onOpenSqlite={vi.fn()} />);
  await Promise.resolve();
  expect(screen.queryByText(/^Version/)).toBeNull();
});
