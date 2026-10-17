import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../lib/ipc";
import type { Catalog } from "../lib/types";
import { useCatalog } from "./catalog";

vi.mock("../lib/ipc");

const cat = (schema: string): Catalog => ({
  schema,
  tables: [{ name: "users", kind: "table", columns: [] }],
});

beforeEach(() => {
  vi.resetAllMocks();
  useCatalog.setState({ catalogs: {}, errors: {}, loading: {} });
});

test("ensureCatalog dedupes concurrent calls and loads once per schema", async () => {
  vi.mocked(ipc.catalogGet).mockResolvedValue(cat("public"));
  const [a, b] = await Promise.all([
    useCatalog.getState().ensureCatalog("w1", "public"),
    useCatalog.getState().ensureCatalog("w1", "public"),
  ]);
  expect(a).toBe(b);
  await useCatalog.getState().ensureCatalog("w1", "public");
  expect(ipc.catalogGet).toHaveBeenCalledTimes(1);
  expect(ipc.catalogGet).toHaveBeenCalledWith("w1", "public", false);
  expect(useCatalog.getState().catalogs.w1.public.catalog.tables).toHaveLength(1);
  await useCatalog.getState().ensureCatalog("w1", "other");
  expect(ipc.catalogGet).toHaveBeenCalledTimes(2);
});

test("a failed load is stored as an error, not thrown, and can be retried", async () => {
  vi.mocked(ipc.catalogGet).mockRejectedValueOnce({ kind: "io", message: "boom" });
  await expect(useCatalog.getState().ensureCatalog("w1", "public")).resolves.toBeNull();
  expect(Object.values(useCatalog.getState().errors)).toEqual(["boom"]);
  vi.mocked(ipc.catalogGet).mockResolvedValueOnce(cat("public"));
  await useCatalog.getState().ensureCatalog("w1", "public");
  expect(useCatalog.getState().errors).toEqual({});
  expect(useCatalog.getState().loading).toEqual({});
});

test("refreshCatalog asks the backend to rebuild and replaces the entry", async () => {
  vi.mocked(ipc.catalogGet).mockResolvedValue(cat("public"));
  await useCatalog.getState().ensureCatalog("w1", "public");
  const fresh: Catalog = { schema: "public", tables: [] };
  vi.mocked(ipc.catalogGet).mockResolvedValue(fresh);
  await useCatalog.getState().refreshCatalog("w1", "public");
  expect(ipc.catalogGet).toHaveBeenLastCalledWith("w1", "public", true);
  expect(useCatalog.getState().catalogs.w1.public.catalog).toBe(fresh);
});

test("a load started before dropWorkspace never writes after it", async () => {
  const deferred: Array<(c: Catalog) => void> = [];
  vi.mocked(ipc.catalogGet).mockImplementation(() => new Promise<Catalog>((r) => deferred.push(r)));
  const stale = useCatalog.getState().ensureCatalog("w1", "public");
  expect(useCatalog.getState().loading).not.toEqual({});
  useCatalog.getState().dropWorkspace("w1");
  expect(useCatalog.getState().loading).toEqual({});

  // A load after the drop does not reuse the stale call.
  const fresh = useCatalog.getState().ensureCatalog("w1", "public");
  expect(ipc.catalogGet).toHaveBeenCalledTimes(2);

  const newDb: Catalog = { schema: "public", tables: [] };
  deferred[1](newDb);
  await expect(fresh).resolves.toBe(newDb);
  deferred[0](cat("public")); // the old database answers last
  await expect(stale).resolves.toBeNull();
  expect(useCatalog.getState().catalogs.w1.public.catalog).toBe(newDb);
  expect(useCatalog.getState().loading).toEqual({});

  // Same for a failure of the stale call: no error is recorded.
  vi.mocked(ipc.catalogGet).mockRejectedValueOnce({ kind: "io", message: "old db gone" });
  const failing = useCatalog.getState().refreshCatalog("w1", "public");
  useCatalog.getState().dropWorkspace("w1");
  await expect(failing).resolves.toBeNull();
  expect(useCatalog.getState().errors).toEqual({});
  expect(useCatalog.getState().catalogs.w1).toBeUndefined();
});
