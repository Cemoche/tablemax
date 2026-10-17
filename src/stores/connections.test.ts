import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../lib/ipc";
import type { ConnectionConfig } from "../lib/types";
import { useConnections } from "./connections";

vi.mock("../lib/ipc");

const cfg = (id: string, name: string): ConnectionConfig => ({
  id,
  name,
  color: "swatch-1",
  envTag: "local",
  kind: "postgres",
  host: "localhost",
  port: 5432,
  user: "u",
  database: null,
  sqlitePath: null,
  passwordMode: "keyring",
  group: null,
  ssl: { mode: "prefer", caFile: null, certFile: null, keyFile: null },
  ssh: null,
});

beforeEach(() => {
  useConnections.setState({ items: [] });
  vi.resetAllMocks();
});

test("store load sorts by name and remove drops item", async () => {
  vi.mocked(ipc.connectionsList).mockResolvedValue([cfg("2", "beta"), cfg("1", "Alpha")]);
  vi.mocked(ipc.connectionDelete).mockResolvedValue(undefined);
  await useConnections.getState().load();
  expect(useConnections.getState().items.map((c) => c.name)).toEqual(["Alpha", "beta"]);
  await useConnections.getState().remove("1");
  expect(ipc.connectionDelete).toHaveBeenCalledWith("1");
  expect(useConnections.getState().items.map((c) => c.id)).toEqual(["2"]);
});

test("save upserts the returned config and forwards the password", async () => {
  vi.mocked(ipc.connectionSave).mockResolvedValue(cfg("9", "Zed"));
  const saved = await useConnections.getState().save(cfg("", "Zed"), "pw", "ssh-pw");
  expect(ipc.connectionSave).toHaveBeenCalledWith(expect.objectContaining({ name: "Zed" }), "pw", "ssh-pw");
  expect(saved.id).toBe("9");
  expect(useConnections.getState().items).toHaveLength(1);
});
