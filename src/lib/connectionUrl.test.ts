import { expect, test } from "vitest";
import { parseConnectionUrl, toConnectionUrl } from "./connectionUrl";
import type { ConnectionConfig } from "./types";

const noSsl = { mode: "prefer" as const, caFile: null, certFile: null, keyFile: null };
const pgCfg: ConnectionConfig = {
  id: "x",
  name: "n",
  color: "swatch-1",
  envTag: "local",
  kind: "postgres",
  host: "db.example.com",
  port: 5432,
  user: "u",
  database: null,
  sqlitePath: null,
  passwordMode: "keyring",
  group: null,
  ssl: noSsl,
  ssh: null,
};

test("round-trips a postgres config without the password", () => {
  const url = toConnectionUrl({ ...pgCfg, user: "a b", database: "shop", ssl: { ...noSsl, mode: "verifyFull" } });
  expect(url).toBe("postgresql://a%20b@db.example.com:5432/shop?sslmode=verify-full");
  expect(parseConnectionUrl(url).config).toMatchObject({
    kind: "postgres",
    user: "a b",
    database: "shop",
    ssl: { mode: "verifyFull" },
  });
});

test("a remote prefer mode is kept explicit so it round-trips", () => {
  const url = toConnectionUrl(pgCfg);
  expect(url).toBe("postgresql://u@db.example.com:5432?sslmode=prefer");
  expect(parseConnectionUrl(url).config.ssl?.mode).toBe("prefer");
});

test("a local prefer mode adds no param", () => {
  expect(toConnectionUrl({ ...pgCfg, host: "localhost" })).toBe("postgresql://u@localhost:5432");
});

test("password in URL is returned separately", () => {
  const r = parseConnectionUrl("mysql://root:s3cret@127.0.0.1/app");
  expect(r.password).toBe("s3cret");
  expect(r.config.port).toBe(3306);
  expect(r.config.kind).toBe("mySql");
  expect(JSON.stringify(r.config)).not.toContain("s3cret");
});

test("sqlite absolute path", () => {
  expect(parseConnectionUrl("sqlite:///home/u/x.db").config).toMatchObject({
    kind: "sqlite",
    sqlitePath: "/home/u/x.db",
  });
  expect(
    toConnectionUrl({ ...pgCfg, kind: "sqlite", sqlitePath: "/home/u/x.db" }),
  ).toBe("sqlite:///home/u/x.db");
});

test("mysql ssl-mode and unknown params warn", () => {
  const r = parseConnectionUrl("mysql://u@db.example.com/app?ssl-mode=REQUIRED&foo=1");
  expect(r.config.ssl?.mode).toBe("require");
  expect(r.warnings).toEqual(['unknown parameter "foo"']);
});

test("verify-ca on mysql becomes verify-full with a warning", () => {
  const r = parseConnectionUrl("mariadb://u@db.example.com/app?sslmode=verify-ca");
  expect(r.config).toMatchObject({ kind: "mariaDb", ssl: { mode: "verifyFull" } });
  expect(r.warnings).toEqual(["verify-ca is not supported for MySQL; using verify-full"]);
});

test("ipv6 host", () => {
  const r = parseConnectionUrl("postgresql://u@[::1]:5433/db");
  expect(r.config).toMatchObject({ host: "::1", port: 5433, database: "db" });
  expect(toConnectionUrl({ ...pgCfg, host: "::1", port: 5433, database: "db" })).toBe(
    "postgresql://u@[::1]:5433/db",
  );
});

test("ssh param round-trips", () => {
  const cfg = {
    ...pgCfg,
    host: "db.internal",
    ssh: { host: "bastion.example", port: 2200, user: "deploy", auth: "agent" as const, keyFile: null, secretMode: "none" as const },
  };
  const url = toConnectionUrl(cfg);
  expect(url).toBe("postgresql://u@db.internal:5432?ssh=deploy%40bastion.example%3A2200&ssh-auth=agent");
  expect(parseConnectionUrl(url).config.ssh).toMatchObject({ host: "bastion.example", port: 2200, user: "deploy" });
  expect(parseConnectionUrl("postgresql://u@db.internal/x?ssh=bastion").config.ssh).toMatchObject({
    host: "bastion",
    port: null,
    user: null,
  });
});

test("default ssl mode follows the host when sslmode is absent", () => {
  expect(parseConnectionUrl("postgresql://u@db.example.com/x").config.ssl?.mode).toBe("verifyFull");
  expect(parseConnectionUrl("postgresql://u@localhost/x").config.ssl?.mode).toBe("prefer");
  expect(parseConnectionUrl("postgresql://u@db.example.com/x?ssh=b").config.ssl?.mode).toBe("prefer");
});

test("rejects unknown scheme and garbage", () => {
  expect(() => parseConnectionUrl("redis://x")).toThrow("Not a valid connection URL");
  expect(() => parseConnectionUrl("not a url")).toThrow("Not a valid connection URL");
});

const roundTrip = (cfg: ConnectionConfig) => parseConnectionUrl(toConnectionUrl(cfg));

test("sqlite paths with # ? % and spaces round-trip", () => {
  for (const path of ["/tmp/a#b.db", "/tmp/a?b=1.db", "/tmp/100%25.db", "/tmp/my dir/x y.db"]) {
    const r = roundTrip({ ...pgCfg, kind: "sqlite", sqlitePath: path });
    expect(r.config.sqlitePath).toBe(path);
    expect(r.warnings).toEqual([]);
  }
});

test("user and database with @ : / ? # % round-trip", () => {
  const user = "a@b:c/d?e#f%g";
  const database = "d@b:n/m?x#y%z";
  const r = roundTrip({ ...pgCfg, user, database });
  expect(r.config).toMatchObject({ user, database, host: "db.example.com" });
  expect(r.password).toBeNull();
  expect(r.warnings).toEqual([]);
});

test("ssh auth round-trips and password auth adds no param", () => {
  const ssh = { host: "bastion", port: null, user: null, auth: "agent" as const, keyFile: null, secretMode: "none" as const };
  const agent = toConnectionUrl({ ...pgCfg, ssh });
  expect(agent).toContain("ssh-auth=agent");
  expect(parseConnectionUrl(agent).config.ssh).toMatchObject({ auth: "agent", secretMode: "none" });
  const key = toConnectionUrl({ ...pgCfg, ssh: { ...ssh, auth: "key", keyFile: "/home/u/id", secretMode: "keyring" } });
  expect(key).toContain("ssh-auth=key");
  expect(key).not.toContain("/home/u/id");
  expect(parseConnectionUrl(key).config.ssh).toMatchObject({ auth: "key", keyFile: null });
  const pw = toConnectionUrl({ ...pgCfg, ssh: { ...ssh, auth: "password", secretMode: "keyring" } });
  expect(pw).not.toContain("ssh-auth");
  expect(parseConnectionUrl(pw).config.ssh?.auth).toBe("password");
});

test("sslExplicit is true only for a valid sslmode", () => {
  expect(parseConnectionUrl("postgresql://u@localhost/x").sslExplicit).toBe(false);
  expect(parseConnectionUrl("postgresql://u@localhost/x?sslmode=prefer").sslExplicit).toBe(true);
  expect(parseConnectionUrl("mysql://u@localhost/x?ssl-mode=PREFERRED").sslExplicit).toBe(true);
  expect(parseConnectionUrl("postgresql://u@localhost/x?sslmode=allow").sslExplicit).toBe(false);
});

test("an unrecognized sslmode warns as invalid, not unknown", () => {
  const r = parseConnectionUrl("postgresql://u@db.example.com/x?sslmode=allow");
  expect(r.warnings).toEqual(['invalid sslmode "allow"']);
  expect(r.config.ssl?.mode).toBe("verifyFull");
});

test("a password in the ssh user is dropped with a warning", () => {
  const r = parseConnectionUrl("postgresql://u@db.internal/x?ssh=deploy%3Ahunter2%40bastion%3A22");
  expect(r.config.ssh).toMatchObject({ host: "bastion", port: 22, user: "deploy" });
  expect(JSON.stringify(r)).not.toContain("hunter2");
  expect(r.warnings).toEqual(["ssh password in the URL was ignored"]);
});

test("a missing username is left unset and round-trips", () => {
  const r = parseConnectionUrl("postgresql://db.example.com/x");
  expect(r.config.user).toBeUndefined();
  expect(toConnectionUrl({ ...pgCfg, user: "", database: "x" })).toBe(
    "postgresql://db.example.com:5432/x?sslmode=prefer",
  );
});
