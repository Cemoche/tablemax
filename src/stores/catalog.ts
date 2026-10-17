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
/**
 * Bumped by `dropWorkspace`: a load started under an older epoch belongs to a closed
 * workspace or to the database it browsed before a switch, and must not write back.
 */
const epochs = new Map<string, number>();
const epochOf = (wsId: string) => epochs.get(wsId) ?? 0;

export const useCatalog = create<CatalogState>((set, get) => {
  const load = (wsId: string, schema: string | null, refresh: boolean) => {
    const key = catalogKey(wsId, schema);
    const running = inflight.get(key);
    if (running) return running;
    set((s) => {
      const { [key]: _drop, ...errors } = s.errors;
      return { loading: { ...s.loading, [key]: true }, errors };
    });
    const epoch = epochOf(wsId);
    const current = () => epochOf(wsId) === epoch;
    const p: Promise<Catalog | null> = (async () => {
      try {
        const catalog = await ipc.catalogGet(wsId, schema, refresh);
        if (!current()) return null;
        set((s) => ({
          catalogs: {
            ...s.catalogs,
            [wsId]: { ...s.catalogs[wsId], [schema ?? ""]: { catalog, loadedAt: Date.now() } },
          },
        }));
        return catalog;
      } catch (e) {
        if (current()) set((s) => ({ errors: { ...s.errors, [key]: toAppError(e).message } }));
        return null;
      } finally {
        // After a drop, the key's bookkeeping belongs to the newer load (if any).
        if (current()) {
          inflight.delete(key);
          set((s) => {
            const { [key]: _done, ...loading } = s.loading;
            return { loading };
          });
        }
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
    dropWorkspace: (wsId) => {
      epochs.set(wsId, epochOf(wsId) + 1);
      const prefix = `${wsId}\u0000`;
      for (const k of [...inflight.keys()]) if (k.startsWith(prefix)) inflight.delete(k);
      const keep = <T>(rec: Record<string, T>) =>
        Object.fromEntries(Object.entries(rec).filter(([k]) => !k.startsWith(prefix)));
      set((s) => {
        const { [wsId]: _gone, ...catalogs } = s.catalogs;
        return { catalogs, errors: keep(s.errors), loading: keep(s.loading) };
      });
    },
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
