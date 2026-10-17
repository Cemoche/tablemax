import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as ipc from "../../lib/ipc";
import type { ConnectionConfig, ImportPreview } from "../../lib/types";
import { useConnections } from "../../stores/connections";
import { ImportDialog } from "./ImportDialog";

vi.mock("../../lib/ipc");

const config = (name: string, over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: "",
  name,
  color: "swatch-1",
  envTag: "local",
  kind: "postgres",
  host: "127.0.0.1",
  port: 5432,
  user: "demo",
  database: null,
  sqlitePath: null,
  passwordMode: "keyring",
  group: null,
  ssl: { mode: "prefer", caFile: null, certFile: null, keyFile: null },
  ssh: null,
  ...over,
});

const existing = { ...config("Shop"), id: "shop-id" };

const preview: ImportPreview = {
  importId: "imp-1",
  items: [
    { index: 0, config: config("fixture-mysql", { kind: "mySql", port: 3306 }), hasPassword: true, hasSshSecret: false, duplicateOf: null },
    { index: 1, config: config("Shop"), hasPassword: true, hasSshSecret: false, duplicateOf: "shop-id" },
    {
      index: 2,
      config: config("fixture-ssh-key", {
        group: "Fixture Group",
        ssh: { host: "bastion.example.test", port: 22, user: "sshdemo", auth: "key", keyFile: null, secretMode: "keyring" },
      }),
      hasPassword: false,
      hasSshSecret: true,
      duplicateOf: null,
    },
  ],
  warnings: [{ entry: "fixture-ssh-key", message: "SSH key file not included in the export" }],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ipc.importTablePlusDiscard).mockResolvedValue();
  vi.mocked(ipc.connectionsList).mockResolvedValue([existing]);
  useConnections.setState({ items: [existing] });
});

const choose = async (user: ReturnType<typeof userEvent.setup>, password: string) => {
  await user.type(screen.getByLabelText("Export password"), password);
  await user.click(screen.getByRole("button", { name: "Choose file…" }));
};

test("a wrong password shows the error on the first step and retries the same file", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.importTablePlusPreview).mockRejectedValueOnce({
    kind: "invalid",
    message: "wrong password or corrupted file",
  });
  render(<ImportDialog onClose={vi.fn()} />);
  await choose(user, "nope");
  expect(ipc.importTablePlusPreview).toHaveBeenCalledWith("nope", false);
  expect(await screen.findByRole("alert")).toHaveTextContent("wrong password or corrupted file");
  expect(screen.getByLabelText("Export password")).toBeInTheDocument();

  vi.mocked(ipc.importTablePlusPreview).mockResolvedValueOnce(preview);
  await user.clear(screen.getByLabelText("Export password"));
  await user.type(screen.getByLabelText("Export password"), "fixture-pass");
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(ipc.importTablePlusPreview).toHaveBeenLastCalledWith("fixture-pass", true);
  expect(await screen.findByRole("list", { name: "Connections to import" })).toBeInTheDocument();
});

test("Choose another file opens the picker again and a cancelled picker changes nothing", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.importTablePlusPreview)
    .mockRejectedValueOnce({ kind: "invalid", message: "not a TablePlus export" })
    .mockResolvedValueOnce(null);
  render(<ImportDialog onClose={vi.fn()} />);
  await choose(user, "pw");
  expect(await screen.findByRole("alert")).toHaveTextContent("not a TablePlus export");
  // Retrying the same file only helps after a wrong password.
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Choose another file…" }));
  expect(ipc.importTablePlusPreview).toHaveBeenLastCalledWith("pw", false);
  await waitFor(() => expect(screen.getByRole("button", { name: "Choose another file…" })).toBeEnabled());
  expect(ipc.importTablePlusPreview).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("alert")).toHaveTextContent("not a TablePlus export");
  expect(screen.getByLabelText("Export password")).toBeInTheDocument();
});

test("the preview lists every entry with its pills, duplicates unchecked", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.importTablePlusPreview).mockResolvedValue(preview);
  render(<ImportDialog onClose={vi.fn()} />);
  await choose(user, "fixture-pass");
  const list = await screen.findByRole("list", { name: "Connections to import" });
  const box = (name: string) => within(list).getByRole("checkbox", { name: new RegExp(`^${name}`) });
  expect(box("fixture-mysql")).toBeChecked();
  expect(box("Shop")).not.toBeChecked();
  expect(box("fixture-ssh-key")).toBeChecked();
  expect(within(list).getByText("duplicate of Shop")).toBeInTheDocument();
  expect(within(list).getAllByText("password")).toHaveLength(2);
  expect(within(list).getByText("SSH")).toBeInTheDocument();
  expect(within(list).getByText("MySQL")).toBeInTheDocument();
  expect(within(list).getByText("Fixture Group")).toBeInTheDocument();
  expect(screen.getByText("fixture-ssh-key: SSH key file not included in the export")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Import 2 connections" })).toBeEnabled();
  await user.click(box("fixture-mysql"));
  await user.click(box("fixture-ssh-key"));
  expect(screen.getByRole("button", { name: "Import 0 connections" })).toBeDisabled();
});

test("Import commits the checked entries, reloads the list and reports the result", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  vi.mocked(ipc.importTablePlusPreview).mockResolvedValue(preview);
  const saved = [{ ...preview.items[0].config, id: "n1" }, { ...preview.items[1].config, id: "n2" }];
  vi.mocked(ipc.importTablePlusCommit).mockResolvedValue({
    saved,
    warnings: [{ entry: "Shop", message: "keyring unavailable: secrets not saved" }],
  });
  vi.mocked(ipc.connectionsList).mockResolvedValue([existing, ...saved]);
  render(<ImportDialog onClose={onClose} />);
  await choose(user, "fixture-pass");
  const list = await screen.findByRole("list", { name: "Connections to import" });
  await user.click(within(list).getByRole("checkbox", { name: /^Shop/ }));
  await user.click(within(list).getByRole("checkbox", { name: /^fixture-ssh-key/ }));
  await user.click(screen.getByRole("button", { name: "Import 2 connections" }));

  expect(ipc.importTablePlusCommit).toHaveBeenCalledWith("imp-1", [0, 1]);
  expect(await screen.findByText("Imported 2 connections")).toBeInTheDocument();
  expect(ipc.connectionsList).toHaveBeenCalled();
  expect(useConnections.getState().items.map((c) => c.id)).toEqual(["n1", "n2", "shop-id"]);
  expect(screen.getByText("Shop: keyring unavailable: secrets not saved")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalled();
  expect(ipc.importTablePlusDiscard).not.toHaveBeenCalled();
});

test("an expired import goes back to the first step", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.importTablePlusPreview).mockResolvedValue(preview);
  vi.mocked(ipc.importTablePlusCommit).mockRejectedValue({ kind: "notFound", message: "import expired" });
  render(<ImportDialog onClose={vi.fn()} />);
  await choose(user, "fixture-pass");
  await user.click(await screen.findByRole("button", { name: "Import 2 connections" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("import expired");
  expect(screen.getByLabelText("Export password")).toBeInTheDocument();
  // The file is still remembered by the backend: read it again.
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(ipc.importTablePlusPreview).toHaveBeenLastCalledWith("fixture-pass", true);
});

test("closing after a preview discards the pending import", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  vi.mocked(ipc.importTablePlusPreview).mockResolvedValue(preview);
  render(<ImportDialog onClose={onClose} />);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(ipc.importTablePlusDiscard).not.toHaveBeenCalled();

  await choose(user, "fixture-pass");
  await screen.findByRole("list", { name: "Connections to import" });
  await user.keyboard("{Escape}");
  expect(ipc.importTablePlusDiscard).toHaveBeenCalledWith("imp-1");
  expect(onClose).toHaveBeenCalledTimes(2);
});

test("unmounting with a pending import discards it", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.importTablePlusPreview).mockResolvedValue(preview);
  const { unmount } = render(<ImportDialog onClose={vi.fn()} />);
  await choose(user, "fixture-pass");
  await screen.findByRole("list", { name: "Connections to import" });
  unmount();
  expect(ipc.importTablePlusDiscard).toHaveBeenCalledWith("imp-1");
  expect(ipc.importTablePlusDiscard).toHaveBeenCalledTimes(1);
});
