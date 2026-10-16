import { beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as ipc from "../../lib/ipc";
import type { ConnectionConfig } from "../../lib/types";
import { useConnections } from "../../stores/connections";
import { ConnectionForm } from "./ConnectionForm";

vi.mock("../../lib/ipc");

const saved: ConnectionConfig = {
  id: "abc",
  name: "Local PG",
  color: "swatch-1",
  envTag: "local",
  kind: "postgres",
  host: "localhost",
  port: 5432,
  user: "me",
  database: "app",
  sqlitePath: null,
  passwordMode: "keyring",
  group: null,
};

beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
  useConnections.setState({ items: [] });
});

test("switching driver to MySQL sets default port 3306", () => {
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  const port = screen.getByLabelText("Port") as HTMLInputElement;
  expect(port.value).toBe("5432");
  fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "mySql" } });
  expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("3306");
});

test("sqlite hides host fields and shows file path", () => {
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "sqlite" } });
  expect(screen.queryByLabelText("Host")).toBeNull();
  expect(screen.queryByLabelText("Port")).toBeNull();
  expect(screen.getByLabelText("Database file")).toBeInTheDocument();
});

test("Save sends password only when typed", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.connectionSave).mockResolvedValue(saved);
  render(<ConnectionForm connection={saved} onConnect={vi.fn()} />);
  expect(screen.getByLabelText("Password")).toHaveAttribute("placeholder", "Stored in keyring");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(ipc.connectionSave).toHaveBeenCalledTimes(1));
  expect(vi.mocked(ipc.connectionSave).mock.calls[0][1]).toBeNull();

  await user.type(screen.getByLabelText("Password"), "hunter2");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(ipc.connectionSave).toHaveBeenCalledTimes(2));
  expect(vi.mocked(ipc.connectionSave).mock.calls[1][1]).toBe("hunter2");
});

test("Test shows server version on success and error message on Auth", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.connectionTest).mockResolvedValueOnce("16.2");
  render(<ConnectionForm connection={saved} onConnect={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Test" }));
  expect(await screen.findByText(/16\.2/)).toBeInTheDocument();

  vi.mocked(ipc.connectionTest).mockRejectedValueOnce({ kind: "auth", message: "bad credentials" });
  await user.click(screen.getByRole("button", { name: "Test" }));
  expect(await screen.findByText("bad credentials")).toBeInTheDocument();
});

test("identity edit without password shows inline re-enter message", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.connectionSave).mockRejectedValue({ kind: "auth", message: "password required" });
  render(<ConnectionForm connection={saved} onConnect={vi.fn()} />);
  await user.clear(screen.getByLabelText("Host"));
  await user.type(screen.getByLabelText("Host"), "127.0.0.1");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Re-enter the password to apply this change")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Connect saves then hands the saved config to onConnect", async () => {
  const user = userEvent.setup();
  const onConnect = vi.fn();
  vi.mocked(ipc.connectionSave).mockResolvedValue(saved);
  render(<ConnectionForm connection={saved} onConnect={onConnect} />);
  await user.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(onConnect).toHaveBeenCalledWith(saved, null));
});

test("host field shows the preview-build hint", () => {
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  expect(screen.getByText("Only local connections in this preview build")).toBeInTheDocument();
});

test("sqlite never uses a password and switching back restores keyring mode", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.connectionSave).mockImplementation(async (c) => ({ ...c, id: "new" }));
  vi.mocked(ipc.connectionTest).mockResolvedValue("3.46");
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  await user.type(screen.getByLabelText("Name"), "lite");
  await user.type(screen.getByLabelText("Password"), "typed-before-switch");
  fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "sqlite" } });
  fireEvent.change(screen.getByLabelText("Database file"), { target: { value: "/tmp/a.db" } });

  await user.click(screen.getByRole("button", { name: "Test" }));
  await waitFor(() => expect(ipc.connectionTest).toHaveBeenCalledTimes(1));
  expect(vi.mocked(ipc.connectionTest).mock.calls[0][0].passwordMode).toBe("none");
  expect(vi.mocked(ipc.connectionTest).mock.calls[0][1]).toBeNull();

  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(ipc.connectionSave).toHaveBeenCalledTimes(1));
  expect(vi.mocked(ipc.connectionSave).mock.calls[0][0].passwordMode).toBe("none");
  expect(vi.mocked(ipc.connectionSave).mock.calls[0][1]).toBeNull();

  fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "postgres" } });
  expect((screen.getByLabelText("Password storage") as HTMLSelectElement).value).toBe("keyring");
});

test("a stored sqlite connection in keyring mode is saved without a password", async () => {
  const user = userEvent.setup();
  const lite: ConnectionConfig = {
    ...saved,
    kind: "sqlite",
    host: "",
    port: 0,
    sqlitePath: "/tmp/a.db",
    passwordMode: "keyring",
  };
  vi.mocked(ipc.connectionSave).mockImplementation(async (c) => c);
  render(<ConnectionForm connection={lite} onConnect={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(ipc.connectionSave).toHaveBeenCalledTimes(1));
  expect(vi.mocked(ipc.connectionSave).mock.calls[0][0].passwordMode).toBe("none");
  expect(vi.mocked(ipc.connectionSave).mock.calls[0][1]).toBeNull();
});
