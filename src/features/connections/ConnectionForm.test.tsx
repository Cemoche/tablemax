import { beforeEach, describe, expect, test, vi } from "vitest";
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
  fireEvent.click(screen.getByLabelText(strings.ssh.enable));
  expect(sslMode()).toBe("prefer");
  fireEvent.click(screen.getByLabelText(strings.ssh.enable));
  expect(sslMode()).toBe("verifyFull");
  fireEvent.change(screen.getByLabelText("SSL mode"), { target: { value: "require" } });
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: "localhost" } });
  expect(sslMode()).toBe("require");
});

test("an existing connection whose mode is the default keeps following host and SSH", () => {
  render(<ConnectionForm connection={saved} onConnect={vi.fn()} />); // localhost, prefer
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: "db.example.com" } });
  expect(sslMode()).toBe("verifyFull");
});

test("an existing connection with a mode picked by the user keeps it", () => {
  const remote: ConnectionConfig = {
    ...saved,
    host: "db.example.com",
    ssl: { ...saved.ssl, mode: "require" },
  };
  render(<ConnectionForm connection={remote} onConnect={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: "db2.example.com" } });
  expect(sslMode()).toBe("require");
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: "localhost" } });
  expect(sslMode()).toBe("require");
});

test("an existing tunnelled connection in prefer verifies once the tunnel is removed", () => {
  const tunnelled: ConnectionConfig = {
    ...saved,
    host: "db.internal",
    ssh: { host: "bastion", port: null, user: "me", auth: "agent", keyFile: null, secretMode: "none" },
  };
  render(<ConnectionForm connection={tunnelled} onConnect={vi.fn()} />);
  expect(sslMode()).toBe("prefer");
  fireEvent.click(screen.getByLabelText(strings.ssh.enable));
  expect(sslMode()).toBe("verifyFull");
});

test("Browse… picks the CA file and Clear removes it", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.filePick).mockResolvedValue("/certs/ca.pem");
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Browse for CA certificate" }));
  expect(ipc.filePick).toHaveBeenCalledWith("caCert");
  await waitFor(() => expect(screen.getByLabelText("CA certificate")).toHaveValue("/certs/ca.pem"));
  await user.click(screen.getByRole("button", { name: "Clear CA certificate" }));
  // No file, no line: the SSL mode line keeps its CA… button.
  expect(screen.queryByLabelText("CA certificate")).toBeNull();
  expect(screen.getByRole("button", { name: "Browse for CA certificate" })).toHaveTextContent(strings.ssl.caShort);
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
  expect(screen.getByLabelText(strings.ssh.enable)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "sqlite" } });
  expect(screen.queryByLabelText("SSL mode")).toBeNull();
  expect(screen.queryByLabelText(strings.ssh.enable)).toBeNull();
});

test("cleartext warning for a remote host in prefer mode, gone with SSH", () => {
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  const warning = () => screen.queryByText(strings.ssl.cleartextWarning);
  expect(warning()).toBeNull(); // localhost
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: "db.example.com" } });
  expect(warning()).toBeNull(); // verifyFull
  fireEvent.change(screen.getByLabelText("SSL mode"), { target: { value: "prefer" } });
  expect(warning()).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(strings.ssh.enable));
  expect(warning()).toBeNull();
});

test("require on a remote host warns that the certificate is not verified", () => {
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  const unverified = () => screen.queryByText(strings.ssl.unverifiedWarning);
  fireEvent.change(screen.getByLabelText("SSL mode"), { target: { value: "require" } });
  expect(unverified()).toBeNull(); // localhost
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: "db.example.com" } });
  expect(unverified()).toBeInTheDocument();
  expect(screen.queryByText(strings.ssl.cleartextWarning)).toBeNull();
  fireEvent.change(screen.getByLabelText("SSL mode"), { target: { value: "verifyFull" } });
  expect(unverified()).toBeNull();
});

test("checking SSH tunnel shows its fields with the ~/.ssh/config aliases", async () => {
  vi.mocked(ipc.sshHostsList).mockResolvedValue(["bastion", "db-jump"]);
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  expect(screen.queryByLabelText("SSH host")).toBeNull();
  fireEvent.click(screen.getByLabelText(strings.ssh.enable));
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
  fireEvent.click(screen.getByLabelText(strings.ssh.enable));
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
  fireEvent.click(screen.getByLabelText(strings.ssh.enable));
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
  fireEvent.click(screen.getByLabelText(strings.ssh.enable));
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
  fireEvent.click(screen.getByLabelText(strings.ssh.enable));
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

test("a stored MySQL connection in verify-ca mode shows verify-full", () => {
  const my: ConnectionConfig = {
    ...saved,
    kind: "mySql",
    port: 3306,
    ssl: { ...saved.ssl, mode: "verifyCa" },
  };
  render(<ConnectionForm connection={my} onConnect={vi.fn()} />);
  expect(sslMode()).toBe("verifyFull");
});

test("Copy URL copies the URL without the password", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(<ConnectionForm connection={saved} onConnect={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Copy URL" }));
  expect(writeText).toHaveBeenCalledWith("postgresql://me@localhost:5432/app");
});

test("a new connection has no Copy URL button", () => {
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Copy URL" })).toBeNull();
});

/** Import from URL… with `url` typed in its dialog. */
async function importUrl(url: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: strings.form.importUrl }));
  const dialog = screen.getByRole("dialog", { name: strings.url.dialogTitle });
  await user.type(within(dialog).getByLabelText(strings.url.label), url);
  await user.click(within(dialog).getByRole("button", { name: strings.url.open }));
}

test("a URL import pre-fills the password and keeps the group suggestions, without saving", async () => {
  useConnections.setState({ items: [{ ...saved, group: "Work" }] });
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  await importUrl("postgresql://me:s3cret@localhost:5432/app");
  expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("s3cret");
  expect(document.querySelector("#cf-groups option")?.getAttribute("value")).toBe("Work");
  expect(ipc.connectionSave).not.toHaveBeenCalled();
});

test("a URL without sslmode follows the host default", async () => {
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  await importUrl("postgresql://me@localhost:5432/app");
  expect(sslMode()).toBe("prefer");
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: "db.example.com" } });
  expect(sslMode()).toBe("verifyFull");
});

test("an explicit sslmode survives a host change", async () => {
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  await importUrl("postgresql://me@localhost:5432/app?sslmode=prefer");
  expect(sslMode()).toBe("prefer");
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: "db.example.com" } });
  expect(sslMode()).toBe("prefer");
});

test("onDirtyChange: an edit, a typed password or a URL import make the form dirty; Save cleans it", async () => {
  const user = userEvent.setup();
  const onDirty = vi.fn();
  vi.mocked(ipc.connectionSave).mockImplementation(async (c) => c);
  const { unmount } = render(<ConnectionForm connection={saved} onConnect={vi.fn()} onDirtyChange={onDirty} />);
  expect(onDirty).toHaveBeenLastCalledWith(false);
  await user.type(screen.getByLabelText("Name"), "!");
  expect(onDirty).toHaveBeenLastCalledWith(true);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(false));
  await user.type(screen.getByLabelText("Password"), "pw");
  expect(onDirty).toHaveBeenLastCalledWith(true);
  await user.clear(screen.getByLabelText("Password"));
  expect(onDirty).toHaveBeenLastCalledWith(false);
  // Picking the Default safe mode again, or a field put back, is no edit.
  await user.selectOptions(screen.getByLabelText(strings.safety.sectionLabel), "off");
  expect(onDirty).toHaveBeenLastCalledWith(true);
  await user.selectOptions(screen.getByLabelText(strings.safety.sectionLabel), "");
  expect(onDirty).toHaveBeenLastCalledWith(false);
  unmount();
  render(<ConnectionForm connection={null} onConnect={vi.fn()} onDirtyChange={onDirty} />);
  expect(onDirty).toHaveBeenLastCalledWith(false);
  await importUrl("postgresql://me@localhost:5432/app");
  expect(onDirty).toHaveBeenLastCalledWith(true);
});

test("Delete asks first: Cancel keeps the connection, Delete removes it", async () => {
  const user = userEvent.setup();
  const onDeleted = vi.fn();
  vi.mocked(ipc.connectionDelete).mockResolvedValue(undefined);
  render(<ConnectionForm connection={saved} onConnect={vi.fn()} onDeleted={onDeleted} />);
  const del = screen.getByRole("button", { name: strings.form.delete });
  await user.click(del);
  const dialog = screen.getByRole("dialog", { name: strings.connections.deleteTitle("Local PG") });
  expect(within(dialog).getByText(strings.connections.deleteMessage)).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: strings.connections.deleteCancel }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(ipc.connectionDelete).not.toHaveBeenCalled();
  expect(del).toHaveFocus();
  await user.click(del);
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: strings.connections.deleteOk }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("abc"));
  expect(ipc.connectionDelete).toHaveBeenCalledWith("abc");
});

test("on open the focus goes to Name for a saved connection, to Driver for a new one", () => {
  const { unmount } = render(<ConnectionForm connection={saved} onConnect={vi.fn()} />);
  expect(screen.getByLabelText("Name")).toHaveFocus();
  unmount();
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  expect(screen.getByLabelText("Driver")).toHaveFocus();
});

test("the Over SSH box's short labels focus their fields", async () => {
  const user = userEvent.setup();
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  fireEvent.click(screen.getByLabelText(strings.ssh.enable));
  const box = screen.getByRole("group", { name: strings.ssh.box });
  await user.click(within(box).getByText(strings.ssh.authShort, { selector: "label" }));
  expect(within(box).getByLabelText("SSH authentication")).toHaveFocus();
  await user.click(within(box).getByText(strings.form.port, { selector: "label" }));
  expect(within(box).getByLabelText("SSH port")).toHaveFocus();
  await user.click(within(box).getByText(strings.form.password, { selector: "label" }));
  expect(within(box).getByLabelText("SSH password")).toHaveFocus();
});

describe("safe mode selector", () => {
  const modeSelect = () => screen.getByLabelText(strings.safety.sectionLabel) as HTMLSelectElement;
  const defaultLabel = () => modeSelect().options[0].textContent;

  test("the Default option names the effective mode of the selected tag", async () => {
    render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
    expect(modeSelect().value).toBe("");
    expect(defaultLabel()).toBe("Default (by tag): Off");
    await userEvent.selectOptions(screen.getByLabelText(strings.form.env), "prod");
    expect(defaultLabel()).toBe("Default (by tag): Confirm writes");
    await userEvent.selectOptions(screen.getByLabelText(strings.form.env), "staging");
    expect(defaultLabel()).toBe("Default (by tag): Off");
    expect([...modeSelect().options].map((o) => o.textContent).slice(1)).toEqual([
      "Off",
      "Confirm writes",
      "Confirm all queries",
    ]);
  });

  test("the chosen mode is saved; Default saves null", async () => {
    vi.mocked(ipc.connectionSave).mockResolvedValue(saved);
    render(<ConnectionForm connection={saved} onConnect={vi.fn()} />);
    await userEvent.selectOptions(modeSelect(), "confirmAll");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ipc.connectionSave).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ipc.connectionSave).mock.calls[0][0].safeMode).toBe("confirmAll");
    await userEvent.selectOptions(modeSelect(), "");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ipc.connectionSave).toHaveBeenCalledTimes(2));
    expect(vi.mocked(ipc.connectionSave).mock.calls[1][0].safeMode).toBeNull();
  });

  test("editing another field keeps the stored safe mode", async () => {
    vi.mocked(ipc.connectionSave).mockResolvedValue(saved);
    render(<ConnectionForm connection={{ ...saved, safeMode: "confirmWrites" }} onConnect={vi.fn()} />);
    expect(modeSelect().value).toBe("confirmWrites");
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "Renamed");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ipc.connectionSave).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ipc.connectionSave).mock.calls[0][0]).toMatchObject({
      name: "Renamed",
      safeMode: "confirmWrites",
    });
  });
});

/** Tailwind spacing class → px (1 unit = 4 px); null when `cls` has no such class. */
function spacing(cls: string, prefix: string): number | null {
  const m = new RegExp(`(?:^|\\s)${prefix}-(\\d+(?:\\.\\d+)?)(?:\\s|$)`).exec(cls);
  return m ? Number(m[1]) * 4 : null;
}

/**
 * The form's height at 100 %, from its classes (jsdom has no layout): each part of the
 * form has a fixed height class (`h-*`), the parts are `gap-*` apart, the form has a
 * `py-*` padding. A part without a fixed height fails the test, so a line that could wrap
 * cannot slip in unnoticed.
 */
function formHeight(form: HTMLElement): number {
  const parts = [...form.children] as HTMLElement[];
  const heights = parts.map((p) => {
    const h = spacing(p.className, "h");
    expect(h, `fixed height of ${p.outerHTML.slice(0, 80)}`).not.toBeNull();
    return h as number;
  });
  const gap = spacing(form.className, "gap") ?? 0;
  const pad = (spacing(form.className, "py") ?? 0) * 2;
  return pad + heights.reduce((a, b) => a + b, 0) + gap * (parts.length - 1);
}

const formOf = () => document.querySelector("form[data-connection-form]") as HTMLElement;

test("form_fits_without_scroll: PostgreSQL and MySQL without SSH fit a 900 px window at 100 %", () => {
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  const form = formOf();
  // Spec §5.2: 620 px wide, 104 px label column, 28 px fields.
  expect(form.className).toContain("w-[620px]");
  expect(form.querySelector("[data-form-row]")?.className).toContain("grid-cols-[104px_minmax(0,1fr)]");
  // 900 px window minus the 52 px toolbar.
  const room = 900 - 52;
  expect(formHeight(form)).toBeLessThanOrEqual(room);
  fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "mySql" } });
  const closed = formHeight(formOf());
  expect(closed).toBeLessThanOrEqual(room);
  // With the tunnel open (password auth) it still fits: the closed box (h-9) becomes its
  // lines of 28 px, 8 px apart, plus its 6 px padding and 1 px border on each side.
  fireEvent.click(screen.getByLabelText(strings.ssh.enable));
  const box = screen.getByRole("group", { name: strings.ssh.box });
  const lines = box.children.length;
  expect(box.className).toMatch(/\bgap-2\b.*\bpy-1\.5\b/);
  expect(closed - 36 + lines * 28 + (lines - 1) * 8 + 2 * 6 + 2).toBeLessThanOrEqual(room);
});

test("form_fields_in_mockup_order", () => {
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  const order = [
    screen.getByLabelText("Driver"),
    screen.getByLabelText("Name"),
    screen.getByLabelText(strings.form.group),
    screen.getByRole("radiogroup", { name: strings.form.color }),
    screen.getByLabelText(strings.form.env),
    screen.getByLabelText(strings.safety.sectionLabel),
    screen.getByLabelText("Host"),
    screen.getByLabelText("Port"),
    screen.getByLabelText("User"),
    screen.getByLabelText("Password"),
    screen.getByLabelText("Password storage"),
    screen.getByLabelText("Database"),
    screen.getByLabelText("SSL mode"),
    screen.getByRole("button", { name: "Browse for CA certificate" }),
    screen.getByRole("button", { name: "Browse for Client certificate" }),
    screen.getByRole("button", { name: "Browse for Client key" }),
    screen.getByLabelText(strings.ssh.enable),
    screen.getByRole("button", { name: strings.form.importUrl }),
    screen.getByRole("button", { name: "Test" }),
    screen.getByRole("button", { name: "Save" }),
    screen.getByRole("button", { name: "Connect" }),
  ];
  for (let i = 1; i < order.length; i++) {
    const follows = order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(follows, `${i}`).toBeTruthy();
  }
  // Two fields on a line: Host and Port, Password and its storage, the colours and the tag.
  const line = (el: HTMLElement) => el.closest("[data-form-row]");
  expect(line(screen.getByLabelText("Port"))).toBe(line(screen.getByLabelText("Host")));
  expect(line(screen.getByLabelText("Password storage"))).toBe(line(screen.getByLabelText("Password")));
  expect(line(screen.getByLabelText(strings.form.env))).toBe(
    line(screen.getByRole("radiogroup", { name: strings.form.color })),
  );
});

test("color_swatches_select: six swatch radios replace the picker, the choice is saved", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.connectionSave).mockImplementation(async (c) => c);
  render(<ConnectionForm connection={saved} onConnect={vi.fn()} />);
  const group = screen.getByRole("radiogroup", { name: strings.form.color });
  const radios = within(group).getAllByRole("radio");
  expect(radios).toHaveLength(6);
  expect(within(group).getByRole("radio", { name: strings.form.colorLabel(1) })).toBeChecked();
  // Each swatch shows its colour in the shade that stands out (tokens.test.ts).
  expect(group.querySelectorAll('[class*="bg-swatch-"][class*="-icon"]')).toHaveLength(6);
  await user.click(within(group).getByRole("radio", { name: strings.form.colorLabel(3) }));
  expect(within(group).getByRole("radio", { name: strings.form.colorLabel(3) })).toBeChecked();
  expect(within(group).getByRole("radio", { name: strings.form.colorLabel(1) })).not.toBeChecked();
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(ipc.connectionSave).toHaveBeenCalledTimes(1));
  expect(lastSaved()[0].color).toBe("swatch-3");
});

test("ssh_box_toggles: the Over SSH box opens and closes the tunnel's lines", () => {
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  const box = screen.getByRole("group", { name: strings.ssh.box });
  const toggle = within(box).getByLabelText(strings.ssh.enable);
  expect(toggle).not.toBeChecked();
  expect(within(box).queryByLabelText("SSH host")).toBeNull();
  fireEvent.click(toggle);
  for (const name of ["SSH host", "SSH port", "SSH user", "SSH authentication", "SSH password", "Secret storage"]) {
    expect(within(box).getByLabelText(name), name).toBeInTheDocument();
  }
  // The box's lines keep the form's label column, less its border and padding.
  expect(within(box).getByLabelText("SSH user").closest("div")?.className).toContain("grid-cols-[calc(104px-0.5rem-1px)");
  fireEvent.click(toggle);
  expect(within(box).queryByLabelText("SSH host")).toBeNull();
});

test("Import from URL… fills the form; a new connection is named after its database", async () => {
  const user = userEvent.setup();
  render(<ConnectionForm connection={null} onConnect={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: strings.form.importUrl }));
  const dialog = screen.getByRole("dialog", { name: strings.url.dialogTitle });
  await user.type(within(dialog).getByLabelText(strings.url.label), "mysql://root:pw@db.example.com:3307/shop");
  await user.click(within(dialog).getByRole("button", { name: strings.url.open }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByLabelText("Driver")).toHaveValue("mySql");
  expect(screen.getByLabelText("Host")).toHaveValue("db.example.com");
  expect(screen.getByLabelText("Port")).toHaveValue(3307);
  expect(screen.getByLabelText("User")).toHaveValue("root");
  expect(screen.getByLabelText("Database")).toHaveValue("shop");
  expect(screen.getByLabelText("Name")).toHaveValue("shop");
  // The URL's password is typed in the form, saved only with the connection.
  expect(screen.getByLabelText("Password")).toHaveValue("pw");
  expect(ipc.connectionSave).not.toHaveBeenCalled();
});

test("the header's back button returns to the list", async () => {
  const onClose = vi.fn();
  render(<ConnectionForm connection={saved} onConnect={vi.fn()} onClose={onClose} />);
  await userEvent.click(screen.getByRole("button", { name: strings.connections.back }));
  expect(onClose).toHaveBeenCalled();
});
