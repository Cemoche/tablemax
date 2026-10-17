import { beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
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
  ssl: { mode: "prefer", caFile: null, certFile: null, keyFile: null },
  ssh: null,
};

const FP = "SHA256:abcDEF0123456789abcDEF0123456789abcDEF01234";

beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.mocked(ipc.sshHostsList).mockResolvedValue([]);
  useConnections.setState({ items: [] });
});

const sslModes = () =>
  [...(screen.getByLabelText("SSL mode") as HTMLSelectElement).options].map((o) => o.value);
const sslMode = () => (screen.getByLabelText("SSL mode") as HTMLSelectElement).value;
const lastSaved = () => {
  const calls = vi.mocked(ipc.connectionSave).mock.calls;
  return calls[calls.length - 1];
};

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
  await waitFor(() => expect(onConnect).toHaveBeenCalledWith(saved, null, null));
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

test("verify-ca is offered for PostgreSQL but not for MySQL or MariaDB", () => {
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  expect(sslModes()).toEqual(["disable", "prefer", "require", "verifyCa", "verifyFull"]);
  fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "mySql" } });
  expect(sslModes()).not.toContain("verifyCa");
  fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "mariaDb" } });
  expect(sslModes()).not.toContain("verifyCa");
});

test("switching to MySQL while verify-ca is selected falls back to verify-full", () => {
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("SSL mode"), { target: { value: "verifyCa" } });
  fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "mySql" } });
  expect(sslMode()).toBe("verifyFull");
});

test("the default SSL mode follows host and SSH until the user picks one", () => {
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  expect(sslMode()).toBe("prefer");
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: "db.example.com" } });
  expect(sslMode()).toBe("verifyFull");
  fireEvent.click(screen.getByLabelText("SSH tunnel"));
  expect(sslMode()).toBe("prefer");
  fireEvent.click(screen.getByLabelText("SSH tunnel"));
  expect(sslMode()).toBe("verifyFull");
  fireEvent.change(screen.getByLabelText("SSL mode"), { target: { value: "require" } });
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: "localhost" } });
  expect(sslMode()).toBe("require");
});

test("an existing connection keeps its stored SSL mode", () => {
  render(<ConnectionForm connection={saved} onConnect={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: "db.example.com" } });
  expect(sslMode()).toBe("prefer");
});

test("Browse… picks the CA file and Clear removes it", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.filePick).mockResolvedValue("/certs/ca.pem");
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Browse for CA certificate" }));
  expect(ipc.filePick).toHaveBeenCalledWith("caCert");
  await waitFor(() => expect(screen.getByLabelText("CA certificate")).toHaveValue("/certs/ca.pem"));
  await user.click(screen.getByRole("button", { name: "Clear CA certificate" }));
  expect(screen.getByLabelText("CA certificate")).toHaveValue("");
});

test("a cancelled file pick keeps the current path", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.filePick).mockResolvedValueOnce("/certs/client.pem").mockResolvedValueOnce(null);
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  const browse = screen.getByRole("button", { name: "Browse for Client certificate" });
  await user.click(browse);
  await waitFor(() => expect(screen.getByLabelText("Client certificate")).toHaveValue("/certs/client.pem"));
  await user.click(browse);
  expect(ipc.filePick).toHaveBeenLastCalledWith("clientCert");
  expect(screen.getByLabelText("Client certificate")).toHaveValue("/certs/client.pem");
});

test("SQLite hides the SSL and SSH sections", () => {
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  expect(screen.getByLabelText("SSL mode")).toBeInTheDocument();
  expect(screen.getByLabelText("SSH tunnel")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "sqlite" } });
  expect(screen.queryByLabelText("SSL mode")).toBeNull();
  expect(screen.queryByLabelText("SSH tunnel")).toBeNull();
});

test("cleartext warning for a remote host in prefer mode, gone with SSH", () => {
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  const warning = () => screen.queryByText(strings.ssl.cleartextWarning);
  expect(warning()).toBeNull(); // localhost
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: "db.example.com" } });
  expect(warning()).toBeNull(); // verifyFull
  fireEvent.change(screen.getByLabelText("SSL mode"), { target: { value: "prefer" } });
  expect(warning()).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("SSH tunnel"));
  expect(warning()).toBeNull();
});

test("checking SSH tunnel shows its fields with the ~/.ssh/config aliases", async () => {
  vi.mocked(ipc.sshHostsList).mockResolvedValue(["bastion", "db-jump"]);
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  expect(screen.queryByLabelText("SSH host")).toBeNull();
  fireEvent.click(screen.getByLabelText("SSH tunnel"));
  const host = screen.getByLabelText("SSH host");
  expect(screen.getByLabelText("SSH port")).toBeInTheDocument();
  expect(screen.getByLabelText("SSH user")).toBeInTheDocument();
  expect(screen.getByLabelText("SSH authentication")).toBeInTheDocument();
  expect(screen.getByLabelText("SSH password")).toBeInTheDocument();
  await waitFor(() => {
    const list = document.getElementById(host.getAttribute("list") ?? "");
    expect([...(list?.querySelectorAll("option") ?? [])].map((o) => o.value)).toEqual(["bastion", "db-jump"]);
  });
  expect(screen.getByLabelText("SSH user")).not.toHaveAttribute("placeholder", "from ~/.ssh/config");
  fireEvent.change(host, { target: { value: "bastion" } });
  expect(screen.getByLabelText("SSH user")).toHaveAttribute("placeholder", "from ~/.ssh/config");
  expect(screen.getByLabelText("SSH port")).toHaveAttribute("placeholder", "from ~/.ssh/config");
});

test("Save sends the SSH settings and the typed SSH password", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.connectionSave).mockImplementation(async (c) => ({ ...c, id: "new" }));
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  await user.type(screen.getByLabelText("Name"), "via ssh");
  fireEvent.click(screen.getByLabelText("SSH tunnel"));
  await user.type(screen.getByLabelText("SSH host"), "127.0.0.1");
  await user.type(screen.getByLabelText("SSH port"), "2222");
  await user.type(screen.getByLabelText("SSH user"), "tunnel");
  await user.type(screen.getByLabelText("SSH password"), "tunnel-pass");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(ipc.connectionSave).toHaveBeenCalledTimes(1));
  const [config, password, sshSecret] = lastSaved();
  expect(config.ssh).toEqual({
    host: "127.0.0.1",
    port: 2222,
    user: "tunnel",
    auth: "password",
    keyFile: null,
    secretMode: "keyring",
  });
  expect(password).toBeNull();
  expect(sshSecret).toBe("tunnel-pass");
});

test("key auth: Browse… picks the key; no passphrase typed saves secret mode none", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.connectionSave).mockImplementation(async (c) => ({ ...c, id: "new" }));
  vi.mocked(ipc.filePick).mockResolvedValue("/home/me/.ssh/id_ed25519");
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  await user.type(screen.getByLabelText("Name"), "key");
  fireEvent.click(screen.getByLabelText("SSH tunnel"));
  await user.type(screen.getByLabelText("SSH host"), "bastion");
  fireEvent.change(screen.getByLabelText("SSH authentication"), { target: { value: "key" } });
  expect(screen.getByLabelText("Passphrase")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Browse for Private key file" }));
  expect(ipc.filePick).toHaveBeenCalledWith("sshKey");
  await waitFor(() => expect(screen.getByLabelText("Private key file")).toHaveValue("/home/me/.ssh/id_ed25519"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(ipc.connectionSave).toHaveBeenCalledTimes(1));
  expect(lastSaved()[0].ssh).toMatchObject({
    auth: "key",
    keyFile: "/home/me/.ssh/id_ed25519",
    secretMode: "none",
  });
  expect(lastSaved()[2]).toBeNull();
});

test("key auth with a typed passphrase keeps keyring mode and sends it", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.connectionSave).mockImplementation(async (c) => ({ ...c, id: "new" }));
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  await user.type(screen.getByLabelText("Name"), "key");
  fireEvent.click(screen.getByLabelText("SSH tunnel"));
  await user.type(screen.getByLabelText("SSH host"), "bastion");
  fireEvent.change(screen.getByLabelText("SSH authentication"), { target: { value: "key" } });
  await user.type(screen.getByLabelText("Passphrase"), "pp");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(ipc.connectionSave).toHaveBeenCalledTimes(1));
  expect(lastSaved()[0].ssh?.secretMode).toBe("keyring");
  expect(lastSaved()[2]).toBe("pp");
});

test("a stored key + keyring passphrase is kept when saving untouched", async () => {
  const user = userEvent.setup();
  const withKey: ConnectionConfig = {
    ...saved,
    ssh: { host: "bastion", port: null, user: null, auth: "key", keyFile: null, secretMode: "keyring" },
  };
  vi.mocked(ipc.connectionSave).mockImplementation(async (c) => c);
  render(<ConnectionForm connection={withKey} onConnect={vi.fn()} />);
  expect(screen.getByLabelText("Passphrase")).toHaveAttribute("placeholder", "Stored in keyring");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(ipc.connectionSave).toHaveBeenCalledTimes(1));
  expect(lastSaved()[0].ssh?.secretMode).toBe("keyring");
});

test("agent auth hides the secret and saves secret mode none", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.connectionSave).mockImplementation(async (c) => ({ ...c, id: "new" }));
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  await user.type(screen.getByLabelText("Name"), "agent");
  fireEvent.click(screen.getByLabelText("SSH tunnel"));
  await user.type(screen.getByLabelText("SSH host"), "bastion");
  await user.type(screen.getByLabelText("SSH password"), "typed");
  fireEvent.change(screen.getByLabelText("SSH authentication"), { target: { value: "agent" } });
  expect(screen.queryByLabelText("SSH password")).toBeNull();
  expect(screen.queryByLabelText("Secret storage")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(ipc.connectionSave).toHaveBeenCalledTimes(1));
  expect(lastSaved()[0].ssh).toMatchObject({ auth: "agent", secretMode: "none" });
  expect(lastSaved()[2]).toBeNull();
});

test("Save asking for the SSH password again shows an inline message", async () => {
  const user = userEvent.setup();
  const withSsh: ConnectionConfig = {
    ...saved,
    ssh: { host: "bastion", port: null, user: null, auth: "password", keyFile: null, secretMode: "keyring" },
  };
  vi.mocked(ipc.connectionSave).mockRejectedValue({ kind: "auth", message: "ssh password required" });
  render(<ConnectionForm connection={withSsh} onConnect={vi.fn()} />);
  await user.type(screen.getByLabelText("SSH host"), "2");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText(strings.form.sshPasswordRequired)).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Test asks to trust an unknown host key, then retries accepting it", async () => {
  const user = userEvent.setup();
  const withSsh: ConnectionConfig = {
    ...saved,
    ssh: { host: "127.0.0.1", port: 2222, user: "tunnel", auth: "password", keyFile: null, secretMode: "keyring" },
  };
  vi.mocked(ipc.connectionTest)
    .mockRejectedValueOnce({ kind: "hostKeyUnknown", message: FP })
    .mockResolvedValueOnce("16.4");
  render(<ConnectionForm connection={withSsh} onConnect={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Test" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(FP)).toBeInTheDocument();
  expect(within(dialog).getByText("127.0.0.1:2222")).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Trust and connect" }));
  expect(await screen.findByText(/16\.4/)).toBeInTheDocument();
  expect(vi.mocked(ipc.connectionTest).mock.calls[1].slice(1)).toEqual([null, null, FP]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Test prompts for a missing passphrase and retries with it", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.connectionTest)
    .mockRejectedValueOnce({ kind: "auth", message: "ssh passphrase required" })
    .mockResolvedValueOnce("16.4");
  render(<ConnectionForm connection={saved} onConnect={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Test" }));
  const dialog = await screen.findByRole("dialog", { name: "Key passphrase required" });
  await user.type(within(dialog).getByLabelText("Passphrase"), "pp{Enter}");
  expect(await screen.findByText(/16\.4/)).toBeInTheDocument();
  expect(vi.mocked(ipc.connectionTest).mock.calls[1].slice(1)).toEqual([null, "pp", null]);
});

test("Test shows the changed host key explanation", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.connectionTest).mockRejectedValueOnce({ kind: "hostKeyChanged", message: FP });
  render(<ConnectionForm connection={saved} onConnect={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Test" }));
  expect(await screen.findByText(strings.ssh.hostKeyChanged(FP))).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
});
