import { expect, test } from "vitest";
import type { ConnectionConfig, SshSettings } from "../../lib/types";
import { blankConnection, forBackend, normalize, sslModePicked, withSslMode } from "./connectionDraft";

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
