import { expect, test } from "vitest";
import { parseConnectionUrl, toConnectionUrl } from "./connectionUrl";
import { MONGO_ALLOWED_OPTIONS, MONGO_REFUSED_OPTIONS, parseMongoUri, toMongoUri } from "./mongoUri";
import { sslModesFor } from "./ssl";
import type { ConnectionConfig } from "./types";

const base: ConnectionConfig = {
  id: "x",
  name: "n",
  color: "swatch-1",
  envTag: "local",
  kind: "mongoDb",
  host: "db1.example.com",
  port: 27017,
  user: "app",
  database: "shop",
  sqlitePath: null,
  passwordMode: "keyring",
  group: null,
  ssl: { mode: "verifyFull", caFile: null, certFile: null, keyFile: null },
  ssh: null,
  mongo: {
    srv: false,
    extraHosts: ["db2.example.com:27018"],
    authSource: "admin",
    authMechanism: "scramSha256",
    replicaSet: "rs0",
    options: [
      ["readPreference", "secondaryPreferred"],
      ["appName", "tablemax"],
    ],
  },
};

test("parses_standard_and_srv", () => {
  const std = parseMongoUri("mongodb://app@h1,h2:27018/shop?authSource=admin");
  expect(std.patch).toMatchObject({ kind: "mongoDb", host: "h1", port: 27017, user: "app", database: "shop" });
  expect(std.patch.mongo).toMatchObject({ srv: false, extraHosts: ["h2:27018"], authSource: "admin" });
  const srv = parseMongoUri("mongodb+srv://app:pw@cluster0.example.net/shop");
  expect(srv.patch.mongo?.srv).toBe(true);
  expect(srv.patch.host).toBe("cluster0.example.net");
  expect(srv.patch.ssl?.mode).toBe("verifyFull");
  expect(srv.password).toBe("pw");
  expect(srv.refused).toEqual([]);
});

test("auth_source_follows_the_standard", () => {
  expect(parseMongoUri("mongodb://u@h/shop").patch.mongo?.authSource).toBe("shop");
  expect(parseMongoUri("mongodb://u@h/shop?authSource=admin").patch.mongo?.authSource).toBe("admin");
  expect(parseMongoUri("mongodb://u@h").patch.mongo?.authSource).toBe("admin");
  expect(parseMongoUri("mongodb://u@h/?authMechanism=PLAIN").patch.mongo?.authSource).toBe("$external");
});

test("tls_options_map_to_modes", () => {
  const mode = (q: string) => parseMongoUri(`mongodb://u@h/db?${q}`).patch.ssl?.mode;
  expect(mode("tls=true&tlsAllowInvalidCertificates=true")).toBe("require");
  expect(mode("tlsInsecure=true")).toBe("require");
  expect(mode("tls=false")).toBe("disable");
  expect(mode("tls=true")).toBe("verifyFull");
  expect(mode("retryReads=true")).toBe("disable");
});

test("refused_and_ignored_options_are_reported", () => {
  const r = parseMongoUri(
    "mongodb://u@h/db?authMechanism=MONGODB-X509&tlsAllowInvalidHostnames=true&retryWrites=true&w=majority",
  );
  expect(r.refused).toEqual(expect.arrayContaining(["authMechanism", "tlsAllowInvalidHostnames"]));
  expect(r.ignored).toEqual(expect.arrayContaining(["retryWrites", "w"]));
  expect(r.ignored).not.toContain("authMechanism");
  expect(MONGO_ALLOWED_OPTIONS).toContain("readPreference");
  expect(MONGO_REFUSED_OPTIONS).toContain("tlsCertificateKeyFile");
  const allowed = parseMongoUri("mongodb://u@h/db?maxPoolSize=5&appName=x");
  expect(allowed.patch.mongo?.options).toEqual([
    ["maxPoolSize", "5"],
    ["appName", "x"],
  ]);
  expect(allowed.refused).toEqual([]);
  expect(parseMongoUri("mongodb://u@h/db?autoEncryptionOpts=1").refused).toContain("autoEncryptionOpts");
});

test("tls_ca_file_is_kept", () => {
  const r = parseMongoUri("mongodb://h/?tls=true&tlsCAFile=%2Fetc%2Fca.pem");
  expect(r.patch.ssl).toEqual({ mode: "verifyFull", caFile: "/etc/ca.pem", certFile: null, keyFile: null });
  expect(r.ignored).toEqual([]);
});

test("tls_ca_file_alone_enables_verify_full", () => {
  const r = parseMongoUri("mongodb://h/?tlsCAFile=%2Fetc%2Fca.pem");
  expect(r.patch.ssl).toEqual({ mode: "verifyFull", caFile: "/etc/ca.pem", certFile: null, keyFile: null });
});

test("insecure_alone_enables_require", () => {
  expect(parseMongoUri("mongodb://h/?tlsInsecure=true").patch.ssl?.mode).toBe("require");
  expect(parseMongoUri("mongodb://h/?tlsAllowInvalidCertificates=true").patch.ssl?.mode).toBe("require");
});

test("tls_false_with_tls_options_is_refused", () => {
  for (const q of ["tlsCAFile=%2Fca.pem", "tlsInsecure=true", "tlsAllowInvalidCertificates=true"]) {
    for (const flag of ["tls=false", "ssl=false"]) {
      const r = parseMongoUri(`mongodb://h/?${flag}&${q}`);
      expect(r.refused).toHaveLength(1);
      expect(r.refused[0]).toContain("tls=false conflicts with");
    }
  }
  expect(parseMongoUri("mongodb://h/?tls=false&tlsInsecure=false").refused).toEqual([]);
});

test("password_never_in_output", () => {
  const parsed = parseMongoUri("mongodb://app:S3cr%40t@h/shop");
  expect(parsed.password).toBe("S3cr@t");
  const out = toMongoUri({ ...base, ...parsed.patch } as ConnectionConfig);
  expect(out).not.toContain("S3cr");
  expect(out).not.toContain(":@");
  expect(toMongoUri({ ...base, user: "" })).not.toContain("@");
});

test("round_trip", () => {
  for (const cfg of [
    base,
    { ...base, ssl: { ...base.ssl, mode: "require" as const } },
    { ...base, ssl: { ...base.ssl, caFile: "/etc/my ca.pem" } },
    { ...base, ssl: { ...base.ssl, mode: "disable" as const }, mongo: { ...base.mongo!, authMechanism: "plain" as const, authSource: "$external" } },
    { ...base, database: null, host: "cluster.example.net", mongo: { ...base.mongo!, srv: true, extraHosts: [], replicaSet: null } },
  ]) {
    const uri = toMongoUri(cfg);
    const back = { ...cfg, ...parseMongoUri(uri).patch };
    expect(back).toEqual(cfg);
  }
  expect(toMongoUri(base)).toContain("authSource=admin");
  expect(toMongoUri({ ...base, ssl: { ...base.ssl, mode: "disable" } })).toContain("tls=false");
});

test("connectionUrl_delegates_mongodb_schemes", () => {
  const { config, password, warnings } = parseConnectionUrl("mongodb://app:pw@h:27019/shop?retryWrites=true");
  expect(config).toMatchObject({ kind: "mongoDb", host: "h", port: 27019, database: "shop" });
  expect(password).toBe("pw");
  expect(warnings).toHaveLength(1);
  expect(() => parseConnectionUrl("mongodb://u@h/?authMechanism=MONGODB-X509")).toThrow();
  expect(toConnectionUrl(base)).toBe(toMongoUri(base));
});

test("mongo_ssl_modes", () => {
  expect(sslModesFor("mongoDb")).toEqual(["disable", "require", "verifyFull"]);
});
