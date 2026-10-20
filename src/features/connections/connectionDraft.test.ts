import { expect, test } from "vitest";
import type { ConnectionConfig, SshSettings } from "../../lib/types";
import {
  blankConnection,
  connectionSubtitle,
  forBackend,
  normalize,
  sameDraft,
  sslModePicked,
  withSslMode,
  withUrlImport,
} from "./connectionDraft";

const ssh = (over: Partial<SshSettings> = {}): SshSettings => ({
  host: "bastion",
  port: null,
  user: null,
  auth: "key",
  keyFile: null,
  secretMode: "keyring",
  ...over,
});
const cfg = (s: SshSettings | null, over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  ...blankConnection(),
  ssh: s,
  ...over,
});

test("key auth without a typed or stored passphrase is sent as secret mode none", () => {
  expect(forBackend(cfg(ssh()), null, null).ssh?.secretMode).toBe("none");
  expect(forBackend(cfg(ssh()), null, "pp").ssh?.secretMode).toBe("keyring");
  expect(forBackend(cfg(ssh()), ssh(), null).ssh?.secretMode).toBe("keyring");
  expect(forBackend(cfg(ssh()), ssh({ auth: "password" }), null).ssh?.secretMode).toBe("none");
  expect(forBackend(cfg(ssh({ secretMode: "ask" })), null, null).ssh?.secretMode).toBe("ask");
});

test("the agent never has a secret; password auth is sent unchanged", () => {
  expect(forBackend(cfg(ssh({ auth: "agent" })), null, null).ssh?.secretMode).toBe("none");
  const pw = cfg(ssh({ auth: "password" }));
  expect(forBackend(pw, null, null)).toBe(pw);
  const direct = cfg(null);
  expect(forBackend(direct, null, null)).toBe(direct);
});

test("withSslMode defaults until picked and never keeps verify-ca on MySQL", () => {
  const remote = cfg(null, { host: "db.example.com" });
  expect(withSslMode(remote, false).ssl.mode).toBe("verifyFull");
  expect(withSslMode(cfg(ssh(), { host: "db.example.com" }), false).ssl.mode).toBe("prefer");
  expect(withSslMode(remote, true).ssl.mode).toBe("prefer");
  const verifyCa = { ...remote, ssl: { ...remote.ssl, mode: "verifyCa" as const } };
  expect(withSslMode(verifyCa, true).ssl.mode).toBe("verifyCa");
  expect(withSslMode({ ...verifyCa, kind: "mySql" }, true).ssl.mode).toBe("verifyFull");
  expect(withSslMode({ ...verifyCa, kind: "mariaDb" }, true).ssl.mode).toBe("verifyFull");
});

test("SQLite is sent without SSH settings", () => {
  const lite = cfg(ssh({ auth: "password" }), { kind: "sqlite" });
  expect(forBackend(lite, null, null).ssh).toBeNull();
});

test("a stored MySQL verify-ca connection loads as verify-full", () => {
  const stored = cfg(null, { kind: "mySql", ssl: { ...blankConnection().ssl, mode: "verifyCa" } });
  expect(normalize(stored).ssl.mode).toBe("verifyFull");
  const pg = { ...stored, kind: "postgres" as const };
  expect(normalize(pg).ssl.mode).toBe("verifyCa");
});

test("a loaded SSL mode counts as picked only when it is not the default", () => {
  const ssl = (mode: ConnectionConfig["ssl"]["mode"]) => ({ ...blankConnection().ssl, mode });
  expect(sslModePicked(null, false)).toBe(false);
  expect(sslModePicked(cfg(null, { host: "localhost", ssl: ssl("prefer") }), false)).toBe(false);
  expect(sslModePicked(cfg(null, { host: "db.example.com", ssl: ssl("verifyFull") }), false)).toBe(false);
  expect(sslModePicked(cfg(ssh(), { host: "db.example.com", ssl: ssl("prefer") }), false)).toBe(false);
  expect(sslModePicked(cfg(null, { host: "db.example.com", ssl: ssl("require") }), false)).toBe(true);
  expect(sslModePicked(cfg(null, { host: "localhost", ssl: ssl("verifyFull") }), false)).toBe(true);
  // A URL that stated its sslmode keeps it even when it is the default.
  expect(sslModePicked(cfg(null, { host: "localhost", ssl: ssl("prefer") }), true)).toBe(true);
});

test("connectionSubtitle: tag : host:port : database, the file path for SQLite", () => {
  const pg = cfg(null, { envTag: "prod", host: "db.example.com", port: 5432, database: "shop" });
  expect(connectionSubtitle(pg)).toBe("prod : db.example.com:5432 : shop");
  expect(connectionSubtitle({ ...pg, database: null })).toBe("prod : db.example.com:5432");
  const lite = cfg(null, { kind: "sqlite", host: "", port: 0, sqlitePath: "/data/a.db" });
  expect(connectionSubtitle(lite)).toBe("local : /data/a.db");
  expect(connectionSubtitle({ ...lite, sqlitePath: null })).toBe("local");
});

test("withUrlImport: the URL's fields over the draft; a nameless draft is named after the database", () => {
  const blank = blankConnection();
  const imported = withUrlImport(blank, { kind: "mySql", host: "db.example.com", port: 3306, database: "shop" });
  expect(imported).toMatchObject({ kind: "mySql", host: "db.example.com", port: 3306, database: "shop", name: "shop" });
  expect(withUrlImport(blank, { host: "h", database: null }).name).toBe("h");
  expect(withUrlImport(blank, { kind: "sqlite", sqlitePath: "/data/a.db" }).name).toBe("a.db");
  // A saved connection keeps who it is: id, name, colour, tag, group, safe mode.
  const saved = cfg(null, {
    id: "abc",
    name: "Shop",
    color: "swatch-3",
    envTag: "prod",
    group: "Work",
    safeMode: "confirmAll",
  });
  expect(withUrlImport(saved, { host: "other", database: "x" })).toMatchObject({
    id: "abc",
    name: "Shop",
    color: "swatch-3",
    envTag: "prod",
    group: "Work",
    safeMode: "confirmAll",
    host: "other",
    database: "x",
  });
});

test("sameDraft ignores key order and null / absent fields, not a changed value", () => {
  const a = blankConnection();
  expect("safeMode" in a).toBe(false);
  expect(sameDraft(a, { ...a, safeMode: null })).toBe(true);
  expect(sameDraft(a, { ...a, safeMode: undefined })).toBe(true);
  expect(sameDraft(a, { ...a, ssl: { keyFile: null, certFile: null, caFile: null, mode: a.ssl.mode } })).toBe(true);
  expect(sameDraft(a, { ...a, name: "x" })).toBe(false);
  expect(sameDraft(a, { ...a, ssl: { ...a.ssl, caFile: "/ca.pem" } })).toBe(false);
  expect(sameDraft(a, { ...a, safeMode: "off" })).toBe(false);
});
