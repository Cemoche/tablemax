import { create } from "zustand";
import * as ipc from "../lib/ipc";
import type { ConnectionConfig } from "../lib/types";

const byName = (a: ConnectionConfig, b: ConnectionConfig) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);

interface ConnectionsState {
  items: ConnectionConfig[];
  load: () => Promise<void>;
  save: (
    cfg: ConnectionConfig,
    password: string | null,
    sshSecret?: string | null,
  ) => Promise<ConnectionConfig>;
  remove: (id: string) => Promise<void>;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  items: [],
  load: async () => {
    const list = await ipc.connectionsList();
    set({ items: [...list].sort(byName) });
  },
  save: async (cfg, password, sshSecret = null) => {
    const saved = await ipc.connectionSave(cfg, password, sshSecret);
    set({ items: [...get().items.filter((c) => c.id !== saved.id), saved].sort(byName) });
    return saved;
  },
  remove: async (id) => {
    await ipc.connectionDelete(id);
    set({ items: get().items.filter((c) => c.id !== id) });
  },
}));
