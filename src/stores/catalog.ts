import { create } from "zustand";
import * as ipc from "../lib/ipc";
import { toAppError } from "../lib/errors";
import type { Catalog } from "../lib/types";
import { useWorkspaces } from "./workspaces";

export interface CatalogEntry {
  catalog: Catalog;
  loadedAt: number;
}

interface CatalogState {
  /** workspace id -> schema -> catalog (a null schema is stored as ""). */
  catalogs: Record<string, Record<string, CatalogEntry>>;
  /** Load errors by `catalogKey`; surfaced by the palette, never thrown. */
  errors: Record<string, string>;
  /** Keys with a call in flight. */
  loading: Record<string, true>;
  /** Loads the catalog once per (workspace, schema); concurrent calls share one backend call. */
  ensureCatalog: (wsId: string, schema: string | null) => Promise<Catalog | null>;
  /** Rebuilds the catalog (bypasses the backend cache). */
  refreshCatalog: (wsId: string, schema: string | null) => Promise<Catalog | null>;
  dropWorkspace: (wsId: string) => void;
}

export const catalogKey = (wsId: string, schema: string | null) => `${wsId}\u0000${schema ?? ""}`;

const inflight = new Map<string, Promise<Catalog | null>>();

export const useCatalog = create<CatalogState>((set, get) => {
  const load = (wsId: string, schema: string | null, refresh: boolean) => {
    const key = catalogKey(wsId, schema);
    const running = inflight.get(key);
    if (running) return running;
    set((s) => {
      const { [key]: _drop, ...errors } = s.errors;
      return { loading: { ...s.loading, [key]: true }, errors };
    });
    const p = (async () => {
      try {
        const catalog = await ipc.catalogGet(wsId, schema, refresh);
        set((s) => ({
          catalogs: {
            ...s.catalogs,
            [wsId]: { ...s.catalogs[wsId], [schema ?? ""]: { catalog, loadedAt: Date.now() } },
          },
        }));
        return catalog;
      } catch (e) {
        set((s) => ({ errors: { ...s.errors, [key]: toAppError(e).message } }));
        return null;
      } finally {
        inflight.delete(key);
        set((s) => {
          const { [key]: _done, ...loading } = s.loading;
          return { loading };
        });
      }
    })();
    inflight.set(key, p);
    return p;
  };

  return {
    catalogs: {},
    errors: {},
    loading: {},
    ensureCatalog: (wsId, schema) => {
      const have = get().catalogs[wsId]?.[schema ?? ""];
      if (have) return Promise.resolve(have.catalog);
      return load(wsId, schema, false);
    },
    refreshCatalog: (wsId, schema) => load(wsId, schema, true),
    dropWorkspace: (wsId) =>
      set((s) => {
        const { [wsId]: _gone, ...catalogs } = s.catalogs;
        const prefix = `${wsId}\u0000`;
        const errors = Object.fromEntries(Object.entries(s.errors).filter(([k]) => !k.startsWith(prefix)));
        return { catalogs, errors };
      }),
  };
});

// A catalog belongs to one database of one open workspace: forget it when the workspace
// closes or switches database.
useWorkspaces.subscribe((state, prev) => {
  const now = new Map(state.workspaces.map((w) => [w.id, w]));
  for (const old of prev.workspaces) {
    const cur = now.get(old.id);
    if (!cur || cur.database !== old.database) useCatalog.getState().dropWorkspace(old.id);
  }
});
